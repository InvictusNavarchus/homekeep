import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLock, AlreadyRunning } from "../src/lock.ts";

test("terminal group SIGINT retains lock until cleanup ends", async () => {
  const state = await mkdtemp(join(tmpdir(), "homekeep-signal-"));
  const module = resolve(import.meta.dir, "../src/lock.ts");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { acquireLock } from ${JSON.stringify(module)};
    process.on("SIGINT", () => console.log("cancelling"));
    const release = await acquireLock(${JSON.stringify(state)});
    console.log("ready");
    await Bun.stdin.text();
    await release();
  `,
    ],
    { detached: true, stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  const reader = child.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "ready",
    );
    process.kill(-child.pid, "SIGINT");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "cancelling",
    );
    // Allow delivery to every group member before probing ownership.
    await Bun.sleep(100);
    await expect(acquireLock(state)).rejects.toBeInstanceOf(AlreadyRunning);
    child.stdin.end();
    expect(await child.exited).toBe(0);
    await (
      await acquireLock(state)
    )();
  } finally {
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    reader.releaseLock();
    await rm(state, { recursive: true, force: true });
  }
});
