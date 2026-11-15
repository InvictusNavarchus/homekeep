import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configSchema, loadPlan } from "../src/config.ts";
import { acquireLock, AlreadyRunning } from "../src/lock.ts";
import { pruneLogs } from "../src/log.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const cli = resolve(import.meta.dir, "../src/cli.ts");

async function fixture(
  paths = ["Documents", "logseq/graphs", "single file;$(touch nope).txt"],
) {
  const root = await mkdtemp(join(tmpdir(), "homekeep-test-"));
  roots.push(root);
  const home = join(root, "home");
  const destination = join(root, "destination");
  const state = join(home, ".local/state/homekeep");
  await mkdir(join(home, "Documents/node_modules"), { recursive: true });
  await mkdir(join(home, "logseq/graphs"), { recursive: true });
  await mkdir(destination);
  await writeFile(join(home, "Documents/keep.txt"), "keep");
  await writeFile(join(home, "Documents/node_modules/skip.txt"), "skip");
  await writeFile(join(home, "logseq/graphs/note.md"), "note");
  await writeFile(join(home, "logseq/unselected.txt"), "not selected");
  await writeFile(join(home, "single file;$(touch nope).txt"), "literal");
  await writeFile(join(home, "private.txt"), "not selected");
  const config = join(root, "config.toml");
  await writeFile(
    config,
    Bun.TOML.stringify({ destination, paths, exclude: ["**/node_modules/**"] }),
  );
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local/state"),
    RCLONE_CONFIG: join(root, "rclone.conf"),
  };
  return { root, home, state, destination, config, env };
}

function invoke(
  f: Awaited<ReturnType<typeof fixture>>,
  args: string[],
  env: NodeJS.ProcessEnv = f.env,
) {
  return Bun.spawn([process.execPath, cli, ...args, "--config", f.config], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}
async function result(child: ReturnType<typeof invoke>) {
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
async function logs(f: Awaited<ReturnType<typeof fixture>>) {
  const directory = join(f.state, "logs");
  return Promise.all(
    (await readdir(directory)).map((name) =>
      readFile(join(directory, name), "utf8"),
    ),
  );
}

test("Zod rejects unknown fields, wrong types, and invalid concurrency", () => {
  for (const extra of [
    { typo: true },
    { rclone: { transfers: "many" } },
    { rclone: { transfers: 0 } },
    { rclone: { checkers: 0 } },
    { rclone: { checkers: 1.5 } },
    { rclone: { checkers: "8" } },
    { logging: { typo: true } },
  ]) {
    expect(
      configSchema.safeParse({
        destination: "drive:backup",
        paths: ["Documents"],
        ...extra,
      }).success,
    ).toBe(false);
  }
  expect(
    configSchema.parse({ destination: "drive:backup", paths: ["Documents"] })
      .rclone.transfers,
  ).toBe(4);
});

test("plan is local and displays mappings without creating state", async () => {
  const f = await fixture();
  const run = await result(invoke(f, ["plan"]));
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("logseq/graphs ->");
  expect(run.stdout).toContain(
    "Transfers: 4\nCheckers: 8\nStatistics interval: 30s",
  );
  expect(await Bun.file(join(f.state, "backup.lock")).exists()).toBe(false);
});

test("CLI tuning overrides config per invocation and reaches rclone", async () => {
  const f = await fixture();
  const config = Bun.TOML.stringify({
    destination: f.destination,
    paths: ["Documents"],
    rclone: { transfers: 3, checkers: 6, stats_seconds: 12 },
  });
  await writeFile(f.config, config);
  const saved = await result(invoke(f, ["plan"]));
  expect(saved.stdout).toContain(
    "Transfers: 3\nCheckers: 6\nStatistics interval: 12s",
  );
  const partial = await result(invoke(f, ["plan", "--transfers", "10"]));
  expect(partial.stdout).toContain(
    "Transfers: 10\nCheckers: 6\nStatistics interval: 12s",
  );
  const flags = ["--transfers", "10", "--checkers=16", "--stats-seconds", "1"];
  const plan = await result(invoke(f, ["plan", ...flags]));
  expect(plan.code).toBe(0);
  expect(plan.stdout).toContain(
    "Transfers: 10\nCheckers: 16\nStatistics interval: 1s",
  );
  const captured = join(f.root, "args.json");
  const env = await fakeRclone(
    f,
    `await Bun.write(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)));`,
  );
  const run = await result(invoke(f, ["backup", "--dry-run", ...flags], env));
  expect(run.code).toBe(0);
  const args: string[] = JSON.parse(await readFile(captured, "utf8"));
  for (const [flag, value] of [
    ["--transfers", "10"],
    ["--checkers", "16"],
    ["--stats", "1s"],
  ]) {
    expect(args[args.indexOf(flag!) + 1]).toBe(value);
  }
  expect(args).toContain("--dry-run");
  expect((await logs(f))[0]).toContain(
    "transfers=10; checkers=16; stats_seconds=1",
  );
  expect(await readFile(f.config, "utf8")).toBe(config);
  const after = await result(invoke(f, ["plan"]));
  expect(after.stdout).toContain(
    "Transfers: 3\nCheckers: 6\nStatistics interval: 12s",
  );
});

test("invalid CLI tuning fails before creating backup state", async () => {
  const f = await fixture();
  for (const flag of ["--transfers", "--checkers", "--stats-seconds"]) {
    for (const value of [
      "0",
      "-1",
      "1.5",
      "many",
      "true",
      "9007199254740992",
    ]) {
      const run = await result(invoke(f, ["backup", `${flag}=${value}`]));
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`${flag} must be a positive integer`);
    }
    expect((await result(invoke(f, ["backup", flag]))).code).toBe(1);
    expect(
      (await result(invoke(f, ["backup", flag, "2", flag, "3"]))).code,
    ).toBe(1);
  }
  expect(await Bun.file(join(f.state, "backup.lock")).exists()).toBe(false);
});

test("destination accepts rclone remote names while rejecting inline parameters", async () => {
  const f = await fixture();
  for (const destination of [
    "My Drive:backup",
    "drive+archive:backup",
    "user@drive:backup",
    "資料２:backup",
    "gdrive-tgwndp:backup",
  ]) {
    await writeFile(
      f.config,
      Bun.TOML.stringify({ destination, paths: ["Documents"] }),
    );
    expect((await loadPlan(f.config, f.home, f.state)).config.destination).toBe(
      destination,
    );
  }
  for (const destination of [
    " drive:backup",
    "drive :backup",
    "-drive:backup",
    ":drive:backup",
    "drive,token=secret:backup",
    "drive/name:backup",
  ]) {
    await writeFile(
      f.config,
      Bun.TOML.stringify({ destination, paths: ["Documents"] }),
    );
    await expect(loadPlan(f.config, f.home, f.state)).rejects.toThrow();
  }
});

test("real rclone preserves nested paths, literal names, exclusions, and remote-only files", async () => {
  const f = await fixture();
  await writeFile(join(f.destination, "retained.txt"), "old");
  const first = await result(invoke(f, ["backup"]));
  expect(first.code).toBe(0);
  expect(
    await readFile(join(f.destination, "Documents/keep.txt"), "utf8"),
  ).toBe("keep");
  expect(
    await readFile(join(f.destination, "logseq/graphs/note.md"), "utf8"),
  ).toBe("note");
  expect(
    await readFile(
      join(f.destination, "single file;$(touch nope).txt"),
      "utf8",
    ),
  ).toBe("literal");
  expect(await Bun.file(join(f.destination, "private.txt")).exists()).toBe(
    false,
  );
  expect(
    await Bun.file(join(f.destination, "logseq/unselected.txt")).exists(),
  ).toBe(false);
  expect(
    await Bun.file(
      join(f.destination, "Documents/node_modules/skip.txt"),
    ).exists(),
  ).toBe(false);
  expect(await readFile(join(f.destination, "retained.txt"), "utf8")).toBe(
    "old",
  );
  const second = await result(invoke(f, ["backup"]));
  expect(second.code).toBe(0);
  expect(second.stdout).toContain("No files transferred");
  expect((await logs(f)).length).toBe(2);
  expect(first.stdout).toContain("Backup succeeded");
  const logFile = (await readdir(join(f.state, "logs")))[0]!;
  expect((await stat(join(f.state, "logs", logFile))).mode & 0o777).toBe(0o600);
  await writeFile(join(f.home, "Documents/keep.txt"), "updated content");
  expect((await result(invoke(f, ["backup"]))).code).toBe(0);
  expect(
    await readFile(join(f.destination, "Documents/keep.txt"), "utf8"),
  ).toBe("updated content");
});

test("dry run leaves the destination unchanged and is logged as a preview", async () => {
  const f = await fixture();
  await mkdir(join(f.destination, "Documents"));
  await writeFile(
    join(f.destination, "Documents/keep.txt"),
    "original destination content",
  );
  await writeFile(join(f.destination, "destination-only.txt"), "retain me");
  const run = await result(invoke(f, ["backup", "--dry-run"]));
  expect(run.code).toBe(0);
  expect((await readdir(f.destination)).sort()).toEqual([
    "Documents",
    "destination-only.txt",
  ]);
  expect(
    await readFile(join(f.destination, "Documents/keep.txt"), "utf8"),
  ).toBe("original destination content");
  expect(
    await readFile(join(f.destination, "destination-only.txt"), "utf8"),
  ).toBe("retain me");
  expect(await readdir(join(f.destination, "Documents"))).toEqual(["keep.txt"]);
  expect(run.stdout).toContain("Dry run completed");
  expect((await logs(f))[0]).toContain("dry run");
});

test("selecting home excludes Homekeep's own state", async () => {
  const f = await fixture(["."]);
  const run = await result(invoke(f, ["backup"]));
  expect(run.code).toBe(0);
  expect(await Bun.file(join(f.destination, "private.txt")).exists()).toBe(
    true,
  );
  await expect(
    stat(join(f.destination, ".local/state/homekeep")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("symlinked home and XDG state ancestors still exclude the entire state subtree", async () => {
  const f = await fixture(["."]);
  const alias = join(f.root, "home-alias");
  await symlink(f.home, alias);
  const env = {
    ...f.env,
    HOME: alias,
    XDG_STATE_HOME: join(alias, ".local/state"),
  };
  const plan = await result(invoke(f, ["plan"], env));
  expect(plan.code).toBe(0);
  expect(plan.stdout).toContain("- /.local/state/homekeep/**");
  await expect(stat(f.state)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await result(invoke(f, ["backup"], env))).code).toBe(0);
  await expect(
    stat(join(f.destination, ".local/state/homekeep")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const stateAlias = join(f.root, "state-alias");
  await symlink(join(f.home, ".local/state"), stateAlias);
  const xdgPlan = await loadPlan(
    f.config,
    f.home,
    join(stateAlias, "homekeep"),
  );
  expect(xdgPlan.state).toBe(f.state);
});

test("missing, escaping, glob, and symlink selections fail before backup", async () => {
  const f = await fixture();
  await symlink(f.destination, join(f.home, "outside"));
  await symlink(join(f.home, "Documents"), join(f.home, "alias"));
  for (const selection of [
    "missing",
    "../destination",
    "/etc",
    "Documents/*",
    "outside",
    "alias",
  ]) {
    await writeFile(
      f.config,
      Bun.TOML.stringify({ destination: f.destination, paths: [selection] }),
    );
    await expect(loadPlan(f.config, f.home, f.state)).rejects.toThrow();
  }
  expect(await readdir(f.destination)).toEqual([]);
});

test("local destination cannot recurse into the source", async () => {
  const f = await fixture();
  await writeFile(
    f.config,
    Bun.TOML.stringify({
      destination: join(f.home, "Documents"),
      paths: ["."],
    }),
  );
  await expect(loadPlan(f.config, f.home, f.state)).rejects.toThrow(
    "outside the home",
  );
});

test("lock contention is detected and releasing permits another run", async () => {
  const f = await fixture();
  const release = await acquireLock(f.state);
  try {
    await expect(acquireLock(f.state)).rejects.toBeInstanceOf(AlreadyRunning);
    const run = await result(invoke(f, ["backup"]));
    expect(run.code).toBe(75);
    expect(run.stderr).toContain("already running");
  } finally {
    await release();
  }
  await (
    await acquireLock(f.state)
  )();
});

test("retention only removes recognized old regular log files", async () => {
  const f = await fixture();
  await mkdir(f.state, { recursive: true });
  const old =
    "homekeep-2000-01-01T00-00-00-000Z-00000000-0000-4000-8000-000000000000.log";
  await writeFile(join(f.state, old), "old");
  await writeFile(join(f.state, "notes.log"), "keep");
  const linked = old.replace("2000-", "2001-");
  await symlink(join(f.state, "notes.log"), join(f.state, linked));
  const malformed = old.replace(
    "00000000-0000-4000-8000-000000000000",
    "a".repeat(36),
  );
  await writeFile(join(f.state, malformed), "not a Homekeep UUID");
  await pruneLogs(f.state, 30);
  expect((await readdir(f.state)).sort()).toEqual(
    [linked, malformed, "notes.log"].sort(),
  );
});

test("logging failure warns and disabled logging creates no files", async () => {
  const f = await fixture();
  await mkdir(f.state, { recursive: true });
  await writeFile(join(f.state, "logs"), "blocks directory creation");
  const run = await result(invoke(f, ["backup"]));
  expect(run.code).toBe(0);
  expect(run.stderr).toContain("file logging unavailable");
  await rm(join(f.state, "logs"));
  await writeFile(
    f.config,
    Bun.TOML.stringify({
      destination: f.destination,
      paths: ["Documents"],
      logging: { enabled: false },
    }),
  );
  expect((await result(invoke(f, ["backup"]))).code).toBe(0);
  expect((await readdir(f.state)).includes("logs")).toBe(false);
});

async function fakeRclone(
  f: Awaited<ReturnType<typeof fixture>>,
  body: string,
) {
  const bin = join(f.root, "bin");
  await mkdir(bin);
  const file = join(bin, "rclone");
  await writeFile(file, `#!${process.execPath}\n${body}\n`);
  await chmod(file, 0o755);
  return { ...f.env, PATH: `${bin}:${process.env.PATH}` };
}

for (const enabled of [true, false]) {
  test(`routes child severity and preserves file output (logging=${enabled})`, async () => {
    const f = await fixture();
    await writeFile(
      f.config,
      Bun.TOML.stringify({
        destination: f.destination,
        paths: ["Documents"],
        logging: { enabled },
      }),
    );
    const env = await fakeRclone(
      f,
      `
      for (const level of ["debug", "info", "notice"])
        console.error(JSON.stringify({level, msg: "routine-" + level}));
      for (const level of ["warning", "error", "critical", "alert", "emergency"])
        console.log(JSON.stringify({level, msg: "diagnostic-" + level}));
      console.error(JSON.stringify({level: "future-level", msg: "unknown-stderr"}));
      console.error(JSON.stringify({msg: "missing-level-stderr"}));
      console.error("raw-stderr");
      console.log("raw-stdout");
    `,
    );
    const run = await result(invoke(f, ["backup"], env));
    expect(run.code).toBe(0);
    const normal = [
      "routine-debug",
      "routine-info",
      "routine-notice",
      "raw-stdout",
      "Backup succeeded",
    ];
    const diagnostic = [
      "diagnostic-warning",
      "diagnostic-error",
      "diagnostic-critical",
      "diagnostic-alert",
      "diagnostic-emergency",
      "unknown-stderr",
      "missing-level-stderr",
      "raw-stderr",
    ];
    for (const message of normal) {
      expect(run.stdout).toContain(message);
      expect(run.stderr).not.toContain(message);
    }
    for (const message of diagnostic) {
      expect(run.stderr).toContain(message);
      expect(run.stdout).not.toContain(message);
    }
    if (enabled) {
      const log = (await logs(f))[0]!;
      for (const message of [...normal, ...diagnostic])
        expect(log).toContain(message);
    } else {
      expect((await readdir(f.state)).includes("logs")).toBe(false);
    }
  });
}

test("partial failure preserves exit status and records child diagnostics", async () => {
  const f = await fixture();
  const env = await fakeRclone(
    f,
    'console.error(JSON.stringify({msg:"simulated partial transfer failure"})); process.exit(7);',
  );
  const run = await result(invoke(f, ["backup"], env));
  expect(run.code).toBe(7);
  expect(run.stderr).toContain("Backup failed; rclone exit=7");
  expect((await logs(f))[0]).toContain("simulated partial transfer failure");
});

test("missing rclone is a logged startup failure and releases the lock", async () => {
  const f = await fixture();
  const bin = join(f.root, "bin");
  await mkdir(bin);
  await symlink(Bun.which("flock")!, join(bin, "flock"));
  const run = await result(invoke(f, ["backup"], { ...f.env, PATH: bin }));
  expect(run.code).toBe(1);
  expect((await logs(f))[0]).toContain("Backup failed");
  await (
    await acquireLock(f.state)
  )();
});

test("SIGTERM stops and reaps rclone, logs cancellation, and releases lock", async () => {
  const f = await fixture();
  const marker = join(f.root, "child.pid");
  const env = await fakeRclone(
    f,
    `await Bun.write(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
  );
  const child = invoke(f, ["backup"], env);
  try {
    const deadline = Date.now() + 4000;
    while (!(await Bun.file(marker).exists())) {
      if (Date.now() > deadline) throw new Error("child did not start");
      await Bun.sleep(20);
    }
    const pid = Number(await readFile(marker, "utf8"));
    child.kill("SIGTERM");
    const run = await result(child);
    expect(run.code).toBe(143);
    expect(run.stderr).toContain("Cancelled (SIGTERM)");
    expect(() => process.kill(pid, 0)).toThrow();
    await (
      await acquireLock(f.state)
    )();
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
});

test("malformed TOML and invalid CLI options fail without a transfer", async () => {
  const f = await fixture();
  await writeFile(f.config, "invalid = =");
  expect((await result(invoke(f, ["backup"]))).code).toBe(1);
  expect((await result(invoke(f, ["backup", "--unknown"]))).code).toBe(1);
  expect((await result(invoke(f, ["unknown-command"]))).code).toBe(1);
});
