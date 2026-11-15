import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

const logName =
  /^homekeep-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.log$/;

export async function pruneLogs(
  directory: string,
  days: number,
  now = Date.now(),
) {
  for (const name of await readdir(directory)) {
    const match = logName.exec(name);
    if (!match?.[1]) continue;
    const date = match[1].replace(
      /T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
      "T$1:$2:$3.$4Z",
    );
    const path = join(directory, name);
    if (
      Date.parse(date) < now - days * 86_400_000 &&
      (await lstat(path)).isFile()
    )
      await unlink(path);
  }
}

export class RunLog {
  private fd: number | undefined;
  readonly path: string | undefined;

  constructor(state: string, enabled: boolean) {
    if (!enabled) return;
    try {
      const directory = join(state, "logs");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(
        directory,
        `homekeep-${new Date().toISOString().replaceAll(":", "-").replace(".", "-")}-${crypto.randomUUID()}.log`,
      );
      this.fd = openSync(path, "wx", 0o600);
      this.path = path;
    } catch {
      console.error(
        "Warning: file logging unavailable; continuing with terminal output.",
      );
    }
  }

  write(message: string) {
    const clean = stripVTControlCharacters(message).replace(
      /[\x00-\x08\x0b-\x1f\x7f]/g,
      "",
    );
    const text = clean
      .split("\n")
      .filter(Boolean)
      .map((line) => `${new Date().toISOString()} ${line}\n`)
      .join("");
    if (text) console.error(text.trimEnd());
    if (this.fd === undefined) return;
    try {
      writeSync(this.fd, text);
    } catch {
      console.error(
        "Warning: file logging failed; continuing with terminal output.",
      );
      this.close();
    }
  }

  close() {
    if (this.fd === undefined) return;
    const fd = this.fd;
    this.fd = undefined;
    try {
      closeSync(fd);
    } catch {
      console.error("Warning: could not close run log.");
    }
  }
}
