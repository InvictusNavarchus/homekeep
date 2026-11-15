import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Plan } from "./config.ts";
import { acquireLock } from "./lock.ts";
import { pruneLogs, RunLog } from "./log.ts";
import { copyArgs, filters } from "./rclone.ts";

const eventSchema = z.object({
  msg: z.string(),
  object: z.string().optional(),
  stats: z
    .object({ transfers: z.number(), checks: z.number(), bytes: z.number() })
    .optional(),
});

async function consume(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      onLine(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
    // A malformed child must not cause unbounded buffering.
    if (pending.length > 65_536) {
      onLine(pending);
      pending = "";
    }
  }
  pending += decoder.decode();
  if (pending) onLine(pending);
}

export async function backup(plan: Plan, dryRun: boolean): Promise<number> {
  const release = await acquireLock(plan.state);
  const log = new RunLog(plan.state, plan.config.logging.enabled);
  const start = performance.now();
  let temporary: string | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let signal: "SIGINT" | "SIGTERM" | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (received: "SIGINT" | "SIGTERM") => {
    signal ??= received;
    child?.kill(received);
    killTimer ??= setTimeout(() => child?.kill("SIGKILL"), 10_000);
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    if (log.path) log.write(`Log: ${log.path}`);
    log.write(
      `Starting ${dryRun ? "dry run" : "backup"}; source=${plan.home}; destination=${plan.config.destination}`,
    );
    log.write(
      `Selections: ${plan.selections.map((item) => item.path || ".").join(", ")}; transfers=${plan.config.rclone.transfers}`,
    );
    if (plan.config.logging.enabled) {
      try {
        await pruneLogs(
          join(plan.state, "logs"),
          plan.config.logging.retention_days,
        );
      } catch {
        log.write("Warning: log retention cleanup unavailable.");
      }
    }
    temporary = await mkdtemp(join(plan.state, "run-"));
    const filterPath = join(temporary, "filters");
    await writeFile(filterPath, filters(plan), { mode: 0o600 });
    if (signal) {
      log.write(`Cancelled (${signal}) before rclone started.`);
      return signal === "SIGINT" ? 130 : 143;
    }
    const proc = Bun.spawn(["rclone", ...copyArgs(plan, filterPath, dryRun)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    child = proc;
    let stats: z.infer<typeof eventSchema>["stats"];
    const output = (line: string) => {
      if (!line) return;
      try {
        const event = eventSchema.safeParse(JSON.parse(line));
        if (event.success) {
          if (event.data.stats) stats = event.data.stats;
          log.write(
            `rclone: ${event.data.object ? `${event.data.object}: ` : ""}${event.data.msg}`,
          );
          return;
        }
      } catch {
        /* Non-JSON startup errors are still useful diagnostics. */
      }
      log.write(`rclone: ${line}`);
    };
    await Promise.all([
      consume(proc.stdout, output),
      consume(proc.stderr, output),
      proc.exited,
    ]);
    const code = await proc.exited;
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    if (signal) {
      log.write(
        `Cancelled (${signal}); rclone exit=${code}; elapsed=${elapsed}s`,
      );
      return signal === "SIGINT" ? 130 : 143;
    }
    const summary = stats
      ? `; transfers=${stats.transfers}; checks=${stats.checks}; bytes=${stats.bytes}`
      : "; statistics unavailable";
    log.write(
      `${code === 0 ? (dryRun ? "Dry run completed" : "Backup succeeded") : "Backup failed"}; rclone exit=${code}; elapsed=${elapsed}s${summary}`,
    );
    if (code === 0 && !dryRun && stats?.transfers === 0)
      log.write(
        "No files transferred; selected files were unchanged or excluded.",
      );
    return code;
  } catch (error) {
    log.write(
      `Backup failed: ${error instanceof Error ? error.message : "unexpected error"}`,
    );
    return 1;
  } finally {
    // Reap the child before releasing ownership, including unexpected stream errors.
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    if (killTimer) clearTimeout(killTimer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    if (temporary)
      await rm(temporary, { recursive: true, force: true }).catch(() =>
        log.write("Warning: temporary filter cleanup failed."),
      );
    log.close();
    await release();
  }
}
