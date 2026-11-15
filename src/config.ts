import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

const line = z
  .string()
  .min(1)
  .refine(
    (value) => !/[\x00-\x1f\x7f]/.test(value),
    "must not contain control characters",
  );
export const configSchema = z.strictObject({
  destination: line.refine(
    (value) =>
      value.trim() === value &&
      !value.startsWith(":") &&
      !value.startsWith("-"),
    "use a named remote or an absolute local path",
  ),
  paths: z.array(line).min(1),
  exclude: z.array(line).default([]),
  rclone: z
    .strictObject({
      transfers: z.number().int().positive().default(4),
      stats_seconds: z.number().int().positive().default(30),
    })
    .prefault({}),
  logging: z
    .strictObject({
      enabled: z.boolean().default(true),
      retention_days: z.number().int().positive().default(30),
    })
    .prefault({}),
});
export type Config = z.infer<typeof configSchema>;
export type Selection = { path: string; directory: boolean };
export type Plan = {
  config: Config;
  home: string;
  state: string;
  selections: Selection[];
};

export function locations() {
  const home = homedir();
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME"]) {
    const value = process.env[key];
    if (value && !isAbsolute(value))
      throw new Error(`${key} must be an absolute path`);
  }
  return {
    home,
    config: join(
      process.env.XDG_CONFIG_HOME || join(home, ".config"),
      "homekeep/config.toml",
    ),
    state: join(
      process.env.XDG_STATE_HOME || join(home, ".local/state"),
      "homekeep",
    ),
  };
}

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

export async function loadPlan(
  configPath: string,
  home: string,
  state: string,
): Promise<Plan> {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error(`Cannot read or parse TOML configuration: ${configPath}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("\n"),
    );
  }
  const config = parsed.data;
  // Restrict destinations to explicit locations, avoiding accidental cwd-relative copies
  // and inline backend credentials in diagnostic output.
  if (
    !isAbsolute(config.destination) &&
    !/^[\w.-]+:[^\x00-\x1f]*$/.test(config.destination)
  ) {
    throw new Error(
      "destination must be a named rclone remote:path or an absolute local path",
    );
  }
  home = await realpath(home);
  if (isAbsolute(config.destination)) {
    // Requiring an existing local destination also catches mistyped drive paths.
    const destination = await realpath(config.destination);
    if (inside(home, destination) || inside(destination, home)) {
      throw new Error(
        "local destination must be outside the home directory and must not contain it",
      );
    }
    if (!(await lstat(destination)).isDirectory())
      throw new Error("local destination must be a directory");
  }
  const selections: Selection[] = [];
  for (const path of new Set(config.paths)) {
    // Reject rclone glob metacharacters rather than silently broadening literal selections.
    if (
      path.trim() !== path ||
      isAbsolute(path) ||
      path.split("/").includes("..") ||
      /[?*\[\]{}\\]/.test(path)
    ) {
      throw new Error(`Unsupported home-relative literal path: ${path}`);
    }
    const absolute = resolve(home, path);
    const canonical = await realpath(absolute);
    if (!inside(home, canonical))
      throw new Error(`Selected path escapes home: ${path}`);
    // rclone does not follow symlinks, including a symlink in a selected parent path.
    if (canonical !== absolute)
      throw new Error(`Selected path traverses a symlink: ${path}`);
    const stat = await lstat(absolute);
    if (!stat.isFile() && !stat.isDirectory())
      throw new Error(`Unsupported source type: ${path}`);
    const normalized = relative(home, absolute);
    selections.push({ path: normalized, directory: stat.isDirectory() });
  }
  return { config, home, state, selections };
}
