#!/usr/bin/env bun
import { cac } from "cac";
import { backup } from "./backup.ts";
import { configSchema, loadPlan, locations } from "./config.ts";
import { AlreadyRunning } from "./lock.ts";
import { filters } from "./rclone.ts";
import { installService } from "./service.ts";
import { version } from "../package.json";

type CommandOptions = {
  config?: string;
  dryRun?: boolean;
  transfers?: unknown;
  checkers?: unknown;
  statsSeconds?: unknown;
};

async function commandPlan(options: CommandOptions) {
  const paths = locations();
  const plan = await loadPlan(
    options.config ?? paths.config,
    paths.home,
    paths.state,
  );
  const overrides: Partial<typeof plan.config.rclone> = {};
  for (const [flag, key, value] of [
    ["transfers", "transfers", options.transfers],
    ["checkers", "checkers", options.checkers],
    ["stats-seconds", "stats_seconds", options.statsSeconds],
  ] as const) {
    if (value === undefined) continue;
    const number =
      typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : typeof value === "number"
          ? value
          : NaN;
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error(`--${flag} must be a positive integer`);
    overrides[key] = number;
  }
  plan.config.rclone = configSchema.shape.rclone.parse({
    ...plan.config.rclone,
    ...overrides,
  });
  return plan;
}

const cli = cac("homekeep");
cli.option(
  "--config <path>",
  "Configuration file (default: XDG config directory)",
);
cli
  .command("plan", "Show configuration, mappings, and rclone filters")
  .option("--transfers <number>", "Override simultaneous file transfers")
  .option("--checkers <number>", "Override parallel file checks")
  .option("--stats-seconds <number>", "Override statistics interval in seconds")
  .action(async (options: CommandOptions) => {
    const plan = await commandPlan(options);
    console.log(
      `Source: ${plan.home}\nDestination: ${plan.config.destination}\nState: ${plan.state}`,
    );
    console.log(
      `Transfers: ${plan.config.rclone.transfers}\nCheckers: ${plan.config.rclone.checkers}\nStatistics interval: ${plan.config.rclone.stats_seconds}s\nFile logging: ${plan.config.logging.enabled}; retention: ${plan.config.logging.retention_days} days`,
    );
    for (const selection of plan.selections)
      console.log(
        `${selection.path || "."} -> ${plan.config.destination.replace(/\/$/, "")}/${selection.path}`,
      );
    console.log(`\nFilters:\n${filters(plan)}`);
  });
cli
  .command("backup", "Copy selected files and record the outcome")
  .option("--transfers <number>", "Override simultaneous file transfers")
  .option("--checkers <number>", "Override parallel file checks")
  .option("--stats-seconds <number>", "Override statistics interval in seconds")
  .option("--dry-run", "Preview changes without copying")
  .action(async (options: CommandOptions) => {
    const plan = await commandPlan(options);
    process.exitCode = await backup(plan, options.dryRun ?? false);
  });
cli
  .command(
    "service <action>",
    "Install or update the systemd user service and timer",
  )
  .option(
    "--time <HH:MM>",
    "Daily local time (new install: 06:00; update: preserve)",
  )
  .option("--enable", "Enable and start the timer after installation")
  .action(
    async (
      action: string,
      options: CommandOptions & { time?: unknown; enable?: boolean },
    ) => {
      if (action !== "install")
        throw new Error("Supported service action: install");
      await installService(options);
    },
  );
cli.help();
cli.version(version);
try {
  cli.parse(process.argv, { run: false });
  if (!cli.matchedCommand && !cli.options.help && !cli.options.version) {
    if (cli.args.length) throw new Error(`Unknown command: ${cli.args[0]}`);
    cli.outputHelp();
  } else await cli.runMatchedCommand();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unexpected failure");
  process.exitCode = error instanceof AlreadyRunning ? 75 : 1;
}
