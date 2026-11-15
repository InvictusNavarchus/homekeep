import { relative } from "node:path";
import { inside, type Plan } from "./config.ts";

export function filters(plan: Plan): string {
  const rules: string[] = [];
  if (inside(plan.home, plan.state)) {
    const state = relative(plan.home, plan.state);
    if (!state || /[?*\[\]{}\\\r\n]/.test(state))
      throw new Error("State path cannot safely be excluded from home");
    rules.push(`- /${state}/**`);
  }
  rules.push(...plan.config.exclude.map((pattern) => `- ${pattern}`));
  for (const item of plan.selections) {
    if (!item.path) rules.push("+ /**");
    else rules.push(`+ /${item.path}${item.directory ? "/**" : ""}`);
  }
  rules.push("- **");
  return `${rules.join("\n")}\n`;
}

export function copyArgs(
  plan: Plan,
  filterPath: string,
  dryRun: boolean,
): string[] {
  return [
    "copy",
    plan.home,
    plan.config.destination,
    "--filter-from",
    filterPath,
    "--transfers",
    String(plan.config.rclone.transfers),
    "--checkers",
    String(plan.config.rclone.checkers),
    "--stats",
    `${plan.config.rclone.stats_seconds}s`,
    "--log-level",
    "INFO",
    "--use-json-log",
    "--color",
    "NEVER",
    ...(dryRun ? ["--dry-run"] : []),
  ];
}
