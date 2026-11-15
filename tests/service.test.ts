import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "homekeep-service-"));
  roots.push(root);
  const config = join(root, 'config space % $ " quote');
  const bin = join(root, "bin");
  await mkdir(bin);
  const calls = join(root, "calls.jsonl");
  for (const name of ["systemctl", "systemd-analyze"]) {
    const file = join(bin, name);
    await writeFile(
      file,
      `#!${process.execPath}\nimport {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)])+'\\n'); process.exit(Number(process.env.FAIL_${name === "systemctl" ? "CTL" : "VERIFY"} ?? 0));\n`,
    );
    await chmod(file, 0o755);
  }
  const units = join(config, "systemd/user");
  return {
    root,
    config,
    units,
    calls,
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: join(root, "state"),
      PATH: `${bin}:${process.env.PATH}`,
      RCLONE_CONFIG: join(root, "rclone.conf"),
    },
  };
}
async function invoke(
  f: Awaited<ReturnType<typeof fixture>>,
  args: string[] = [],
  extra: Record<string, string> = {},
) {
  const proc = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/cli.ts"),
      "service",
      "install",
      ...args,
    ],
    { env: { ...f.env, ...extra }, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
test("installs validated units with escaped paths, reloads, and enables only explicitly", async () => {
  const f = await fixture();
  const run = await invoke(f, [
    "--time",
    "06:15",
    "--config",
    join(f.root, "custom $config.toml"),
  ]);
  expect(run.code).toBe(0);
  const service = await readFile(join(f.units, "homekeep.service"), "utf8");
  expect(service).toContain('ExecStart=:"');
  expect(service).toContain('config space %% $ \\" quote');
  expect(service).toContain("custom $config.toml");
  expect(service).toContain("KillMode=control-group");
  expect(await readFile(join(f.units, "homekeep.timer"), "utf8")).toContain(
    "OnCalendar=*-*-* 06:15:00",
  );
  const calls = (await readFile(f.calls, "utf8"))
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  expect(calls[0].slice(0, 3)).toEqual(["systemd-analyze", "--user", "verify"]);
  expect(calls.slice(1)).toEqual([["systemctl", "--user", "daemon-reload"]]);
  // Real parser validation, without contacting or changing the user manager.
  const verify = Bun.spawn(
    [
      "/usr/bin/systemd-analyze",
      "--user",
      "verify",
      join(f.units, "homekeep.service"),
      join(f.units, "homekeep.timer"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, errors] = await Promise.all([
    verify.exited,
    new Response(verify.stderr).text(),
  ]);
  expect(errors).toBe("");
  expect(code).toBe(0);
  expect((await invoke(f, ["--enable"])).code).toBe(0);
  expect(await readFile(f.calls, "utf8")).toContain(
    '["systemctl","--user","enable","--now","homekeep.timer"]',
  );
});
test("update preserves custom timer verbatim unless time is supplied", async () => {
  const f = await fixture();
  await mkdir(f.units, { recursive: true });
  const timer =
    "[Timer]\nOnCalendar=Mon *-*-* 07:30:00\nRandomizedDelaySec=5m\n[Install]\nWantedBy=timers.target\n";
  await writeFile(join(f.units, "homekeep.timer"), timer);
  expect((await invoke(f)).code).toBe(0);
  expect(await readFile(join(f.units, "homekeep.timer"), "utf8")).toBe(timer);
  expect((await invoke(f, ["--time", "08:00"])).code).toBe(0);
  expect(await readFile(join(f.units, "homekeep.timer"), "utf8")).toContain(
    "08:00:00",
  );
});
test("new installation defaults to 06:00 and invalid times do not invoke system tools", async () => {
  const f = await fixture();
  for (const time of ["25:00", "6:00", "06:60", "noon"])
    expect((await invoke(f, ["--time", time])).code).toBe(1);
  expect(await Bun.file(f.calls).exists()).toBe(false);
  expect((await invoke(f)).code).toBe(0);
  expect(await readFile(join(f.units, "homekeep.timer"), "utf8")).toContain(
    "06:00:00",
  );
});
test("validation failure leaves existing files intact and does not reload or enable", async () => {
  const f = await fixture();
  await mkdir(f.units, { recursive: true });
  await writeFile(join(f.units, "homekeep.service"), "original");
  expect((await invoke(f, ["--enable"], { FAIL_VERIFY: "1" })).code).toBe(1);
  expect(await readFile(join(f.units, "homekeep.service"), "utf8")).toBe(
    "original",
  );
  expect(await Bun.file(join(f.units, "homekeep.timer")).exists()).toBe(false);
  expect(await readFile(f.calls, "utf8")).not.toContain('"systemctl"');
});
test("rejects symlink units and reports reload failures without enabling", async () => {
  const f = await fixture();
  await mkdir(f.units, { recursive: true });
  const other = join(f.root, "other");
  await writeFile(other, "keep");
  await symlink(other, join(f.units, "homekeep.service"));
  expect((await invoke(f)).code).toBe(1);
  expect(await readFile(other, "utf8")).toBe("keep");
  await rm(join(f.units, "homekeep.service"));
  const run = await invoke(f, ["--enable"], { FAIL_CTL: "1" });
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("daemon-reload failed");
  expect(await readFile(f.calls, "utf8")).not.toContain('"enable"');
});
