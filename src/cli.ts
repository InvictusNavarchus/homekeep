#!/usr/bin/env bun
import { cac } from "cac";
import { backup } from "./backup.ts";
import { loadPlan, locations } from "./config.ts";
import { AlreadyRunning } from "./lock.ts";
import { filters } from "./rclone.ts";
import { version } from "../package.json";

const cli = cac("homekeep");
cli.option(
  "--config <path>",
  "Configuration file (default: XDG config directory)",
);
cli
  .command("plan", "Show configuration, mappings, and rclone filters")
  .action(async (options: { config?: string }) => {
    const paths = locations();
    const plan = await loadPlan(
      options.config ?? paths.config,
      paths.home,
      paths.state,
    );
    console.log(
      `Source: ${plan.home}\nDestination: ${plan.config.destination}\nState: ${plan.state}`,
    );
    console.log(
      `Transfers: ${plan.config.rclone.transfers}\nStatistics interval: ${plan.config.rclone.stats_seconds}s\nFile logging: ${plan.config.logging.enabled}; retention: ${plan.config.logging.retention_days} days`,
    );
    for (const selection of plan.selections)
      console.log(
        `${selection.path || "."} -> ${plan.config.destination.replace(/\/$/, "")}/${selection.path}`,
      );
    console.log(`\nFilters:\n${filters(plan)}`);
  });
cli
  .command("backup", "Copy selected files and record the outcome")
  .option("--dry-run", "Preview changes without copying")
  .action(async (options: { config?: string; dryRun?: boolean }) => {
    const paths = locations();
    const plan = await loadPlan(
      options.config ?? paths.config,
      paths.home,
      paths.state,
    );
    process.exitCode = await backup(plan, options.dryRun ?? false);
  });
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
