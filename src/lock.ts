import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

export class AlreadyRunning extends Error {}

export async function acquireLock(state: string): Promise<() => Promise<void>> {
  await mkdir(state, { recursive: true, mode: 0o700 });
  const path = join(state, "backup.lock");
  await (await open(path, "a", 0o600)).close();
  // flock execs this fixed helper while retaining its kernel lock. Closing stdin
  // releases it, including when the parent crashes. No user text is shell code.
  const child = Bun.spawn(
    [
      "flock",
      "--nonblock",
      "--conflict-exit-code",
      "75",
      "--no-fork",
      path,
      process.execPath,
      "-e",
      'console.log("locked"); await Bun.stdin.text();',
    ],
    // Keep terminal SIGINT away from the holder until the parent finishes cleanup.
    { stdin: "pipe", stdout: "pipe", stderr: "inherit", detached: true },
  );
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  reader.releaseLock();
  if (ready.done) {
    const code = await child.exited;
    if (code === 75)
      throw new AlreadyRunning("Another homekeep backup is already running.");
    throw new Error(`Could not acquire backup lock (exit ${code})`);
  }
  return async () => {
    child.stdin.end();
    await child.exited;
  };
}
