import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { locations } from "./config.ts";

// systemd uses C-style quoting and expands percent specifiers even inside quotes.
function quote(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value))
    throw new Error("Service paths must not contain control characters");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

async function run(command: string, args: string[]) {
  const child = Bun.spawn([command, ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (exit ${code})`);
}

async function existing(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile())
      throw new Error(`Refusing to replace non-regular unit: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function installService(options: {
  time?: unknown;
  enable?: boolean;
  config?: string;
}) {
  if (process.platform !== "linux")
    throw new Error("Service installation requires Linux and systemd");
  if (
    options.time !== undefined &&
    (typeof options.time !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(options.time))
  )
    throw new Error("--time must be HH:MM in 24-hour local time");
  const paths = locations();
  const configHome = dirname(dirname(paths.config));
  const directory = join(configHome, "systemd/user");
  const servicePath = join(directory, "homekeep.service");
  const timerPath = join(directory, "homekeep.timer");
  await existing(servicePath);
  const previousTimer = await existing(timerPath);
  const bun = await realpath(process.execPath);
  const cli = await realpath(join(import.meta.dir, "cli.ts"));
  const dependencies = ["rclone", "flock"].map((name) => {
    const path = Bun.which(name);
    if (!path)
      throw new Error(
        `${name} must be installed before installing the service`,
      );
    return dirname(path);
  });
  const path = [
    ...new Set([
      ...dependencies,
      dirname(bun),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]),
  ].join(":");
  const env = [
    `PATH=${path}`,
    `XDG_CONFIG_HOME=${configHome}`,
    `XDG_STATE_HOME=${dirname(paths.state)}`,
    ...(process.env.RCLONE_CONFIG
      ? [`RCLONE_CONFIG=${resolve(process.env.RCLONE_CONFIG)}`]
      : []),
  ];
  // ':' disables ExecStart environment expansion; percent escaping is still required.
  const args = [
    bun,
    cli,
    "backup",
    ...(options.config ? ["--config", resolve(options.config)] : []),
  ];
  const service = `[Unit]
Description=Back up selected home-directory files with Homekeep

[Service]
Type=oneshot
ExecStart=:${args.map(quote).join(" ")}
${env.map((value) => `Environment=${quote(value)}`).join("\n")}
UMask=0077
TimeoutStartSec=infinity
TimeoutStopSec=15s
KillMode=control-group
StandardOutput=journal
StandardError=journal
`;
  const timer =
    options.time === undefined && previousTimer !== undefined
      ? previousTimer
      : `[Unit]
Description=Daily Homekeep backup

[Timer]
OnCalendar=*-*-* ${options.time ?? "06:00"}:00
Persistent=true
WakeSystem=false
Unit=homekeep.service

[Install]
WantedBy=timers.target
`;
  const validation = await mkdtemp(join(tmpdir(), "homekeep-units-"));
  try {
    await writeFile(join(validation, "homekeep.service"), service);
    await writeFile(join(validation, "homekeep.timer"), timer);
    await run("systemd-analyze", [
      "--user",
      "verify",
      join(validation, "homekeep.service"),
      join(validation, "homekeep.timer"),
    ]);
    await mkdir(directory, { recursive: true });
    const staging = await mkdtemp(join(directory, ".homekeep-install-"));
    try {
      await writeFile(join(staging, "homekeep.service"), service, {
        mode: 0o600,
      });
      await writeFile(join(staging, "homekeep.timer"), timer, { mode: 0o600 });
      await rename(join(staging, "homekeep.service"), servicePath);
      await rename(join(staging, "homekeep.timer"), timerPath);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } finally {
    await rm(validation, { recursive: true, force: true });
  }
  console.log(`Installed ${servicePath}\nInstalled ${timerPath}`);
  await run("systemctl", ["--user", "daemon-reload"]);
  if (options.enable) {
    await run("systemctl", ["--user", "enable", "--now", "homekeep.timer"]);
    console.log(
      "Timer enabled and started; a missed schedule may trigger a backup now.",
    );
  } else {
    console.log(
      "Units reloaded; existing timer activation is unchanged. Use --enable to enable and start it.",
    );
  }
  console.log(
    "If these units are managed by chezmoi, capture the updated files with chezmoi add.",
  );
}
