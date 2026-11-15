# Homekeep design

Status: initial CLI implemented. Service examples are provided separately; no service is installed or enabled by the project.

## Purpose and scope

Homekeep backs up selected files and directories beneath the user's home directory while preserving their relative paths at a configured destination. It makes repeated rclone commands easier to configure, inspect, run, and eventually schedule.

The first implementation supports rclone and Google Drive through an existing rclone remote. It uses `rclone copy`: new and changed files are copied, identical files are skipped, and destination files absent from the source are retained. Changed source files can replace destination copies. Renames can leave the old remote name behind.

Version history is outside this tool's scope. The user already uses Git, chezmoi, and Google Docs/Sheets history where needed. Homekeep does not add snapshots, version retention, remote deletion, or a restore interface.

Rsync support is deferred. Scheduling is designed here but should be enabled only after manual execution is verified. The tool must remain useful without systemd.

## Decisions and proposed defaults

The agreed direction is:

- Bun and TypeScript, with strict static type checking.
- cac for command parsing and help output.
- Zod for configuration validation and inferred TypeScript types.
- Bun's built-in `Bun.TOML.parse` for TOML parsing.
- TOML configuration stored outside the project and managed separately with chezmoi.
- One configured destination representing the home-directory root.
- rclone-native filtering and transfer behavior.
- Dry-run support, runtime validation, overlap prevention, and persistent run logs.
- A systemd user service and timer for future automation.

The initial implementation adopts the CLI names, configuration field names, 30-second statistics interval, and 30-day log retention described below. The README is the operational reference. Exact personal selections, exclusions, destination, and schedule remain user configuration decisions. Scheduling policies remain proposals until the user installs and enables the units.

## Runtime choice

Bun and TypeScript fit the user's existing CLI workflow. Rclone performs transfers, so language overhead is not a meaningful factor. TypeScript makes internal data shapes and result states explicit, while Bun avoids introducing another application runtime into this workflow.

Python would also be suitable and does not have a material disadvantage for systemd integration. Fish could wrap a few commands, but configuration validation, structured results, cancellation, and tests are easier to maintain in a general-purpose language as the tool grows.

Executing TypeScript with Bun does not replace static type checking. Provide a separate typecheck script and run scripts through `bun run` (or `bunx` where appropriate). Choose current stable dependencies during implementation; this document does not pin versions.

The initial application dependencies are cac and Zod. Use Bun's built-in TOML parser, subprocess APIs, and test tooling, along with standard filesystem/path APIs. TypeScript and Bun's type definitions are development dependencies. Verify the installed Bun version supports the required APIs and document the minimum supported version during implementation; no separate TOML parser is planned.

## Configuration and ownership

Default configuration: `$XDG_CONFIG_HOME/homekeep/config.toml`, falling back to `~/.config/homekeep/config.toml` when the environment variable is unset or empty. An explicit `--config` option can select another file.

Commit a documented `config.example.toml` to the project. Keep the personal config outside the project and track it through chezmoi. A plain file is sufficient for the current single device; no host templates or profile machinery are needed.

Illustrative personal configuration:

```toml
destination = "gdrive-tgwndp:rclone-backup/256gb-fedora-axioo"

# Paths relative to the current user's home directory.
paths = [
  "Documents",
  "logseq/graphs",
  "backup-phone",
]

# Native rclone exclude patterns, relative to the same home root.
# These are examples, not an agreed list of files to omit.
exclude = [
  "**/node_modules/**",
  "**/__pycache__/**",
]

[rclone]
transfers = 4
checkers = 8
```

Keep remote authentication in rclone's own configuration. Homekeep only stores the destination remote/path, not credentials. Do not commit personal paths or credentials in the project's example.

Logs and runtime files belong under `$XDG_STATE_HOME/homekeep/`, falling back to `~/.local/state/homekeep/`. They do not belong in either Git repository.

## Path mapping and filters

The destination folder itself represents `~`; no extra `home` or username directory is inserted:

```text
~/Documents/report.pdf
  -> gdrive-tgwndp:rclone-backup/256gb-fedora-axioo/Documents/report.pdf

~/logseq/graphs/personal/
  -> gdrive-tgwndp:rclone-backup/256gb-fedora-axioo/logseq/graphs/personal/

~/backup-phone/
  -> gdrive-tgwndp:rclone-backup/256gb-fedora-axioo/backup-phone/
```

Use one rclone operation with the home directory as source. Generate a filter file with exclusions first, includes for selected paths afterward, and a final exclusion for everything else. Rclone evaluates the filters; Homekeep must not implement another recursive file scanner or pattern language.

Selections are literal paths, while `exclude` entries use rclone syntax. Filter generation must account for traversal of parent directories, distinguish files from directories, and escape or reject literal path names that cannot safely be represented. Verify this against rclone rather than assuming shell glob rules apply. Overlapping selections should not cause duplicate work.

Initial symlink policy: do not follow symlinks. Reject explicit selections traversing symlinks, including those resolving outside home; rclone skips symlinks found within selected directories. Always exclude Homekeep's own logs and runtime artifacts if a broader selection could include them.

Do not automatically rename the destination based on the hostname or hardware. Its configured value is the user's stable identifier.

## Validation and command interface

Parsed TOML is untrusted runtime data. Type assertions are not validation. Parse the file with `Bun.TOML.parse`, then validate its contents with Zod at the configuration boundary and pass the validated, typed configuration to the rest of the program. TOML parsing checks document syntax; Zod checks Homekeep's expected fields, values, and defaults.

Proposed validation rules:

- Require a nonempty destination and a nonempty list of selected paths.
- Reject unknown keys so misspelled settings do not silently use defaults.
- Require positive integer transfer concurrency.
- Require home-relative selections; reject absolute paths, `..` traversal, and unsupported file types.
- Check that all selected sources exist before beginning transfers; a missing selection must not quietly count as a successful backup.
- Reject invalid field types and report the field and reason clearly.
- Confirm rclone is available and report remote/configuration failures without exposing credentials.

Define configuration types from the Zod schemas with `z.infer` instead of maintaining separate interfaces for the same shape. Use strict object schemas, including nested settings, to reject unknown keys, and format validation issues as clear field-specific errors. Keep filesystem checks, such as source existence and resolved-path containment, in ordinary functions after schema validation.

Proposed commands:

```text
homekeep plan                 Show resolved configuration and path mappings
homekeep backup --dry-run     Ask rclone to preview work without remote mutation
homekeep backup               Perform one backup and exit
```

Support `--config <path>` and standard cac help/version flags. `plan` is a local inspection, not a claim that the destination is reachable or that every file is readable. A dry run can access the remote and create a local run log; it does not copy files to the destination.

Construct subprocess arguments as an array without shell interpolation. Do not depend on fish initialization, aliases, or the caller's working directory.

## Execution and maintainability

Keep four responsibilities separate using ordinary modules/functions:

1. CLI parsing and validated configuration loading.
2. Path mapping and rclone argument/filter generation.
3. Process execution, lock ownership, and cancellation.
4. Logging and final outcome reporting.

Do not add a backend registry, plugin framework, or generic job engine. Keep rclone-specific construction isolated so a future rsync implementation can be added deliberately. Rclone exclusions must not be passed unchanged to rsync: their semantics are not interchangeable.

Use a process-held lock shared by manual and scheduled invocations. Acquire it before transfer work and log retention cleanup. Linux util-linux `flock` holds the kernel lock through a fixed Bun helper; closing its input releases the lock, including when the parent exits. The persistent lock file itself does not indicate ownership and must not be deleted to clear contention. A competing invocation reports that a run is already active and exits 75. Preserve rclone failure exit codes; use 1 for startup errors, 130 for SIGINT, and 143 for SIGTERM.

Preserve failure semantics: rclone failure must produce a nonzero Homekeep exit status, including partial transfers. Report cancellation separately and terminate/reap the rclone child before normal cleanup. A hard crash may leave no final log summary; its absence is not success.

Rclone owns transfer retries. Do not introduce an unbounded application retry loop.

## Logging

Proposed defaults:

- One uniquely named, timestamped plain-text log per backup or dry run under the state directory's `logs/` subdirectory.
- Display the log path at startup and stream messages to both the terminal and file.
- Capture rclone output instead of using its `--log-file` option, so Homekeep controls both destinations.
- Disable animated progress and ANSI formatting in persisted output. Request periodic rclone statistics every 30 seconds, with the interval configurable.
- Record run identity, start/end timestamps, source/destination scope, dry-run status, elapsed time, and the actual outcome, including rclone's exit code when available.
- Record unchanged/no-op completion clearly without inventing transfer counts. If structured statistics are needed, use an explicit rclone output contract rather than guessing from human-readable lines.
- Retain logs for 30 days; remove only recognized Homekeep log files, never arbitrary files in the directory.
- If file logging fails, warn on stderr and continue the transfer. Do not obscure a transfer failure with a logging error.

Startup validation failures may occur before a run log exists; print those errors directly. Logs can contain private filenames, so use user-private file permissions and do not persist credentials, environment dumps, or raw sensitive configuration.

A small shared logger is sufficient initially. Logs are diagnostic evidence, not a recovery database or proof of a completed upload. Reading and forwarding subprocess output must not introduce pipe deadlocks or collect an entire run's output in memory.

## Systemd integration

Provide example user units for installation under `~/.config/systemd/user/`. The project does not automatically install or enable them. The service runs as the user and invokes the same backup command used interactively.

- Use `Type=oneshot`; perform one backup and exit, without `RemainAfterExit=yes`.
- Use explicit installed executable/entrypoint paths and ensure rclone is resolvable in the service environment.
- Do not launch fish or depend on interactive shell startup files.
- Ensure the service allows long transfers and cancellation stops the entire transfer process group.
- Route terminal output to the journal while preserving Homekeep's own per-run file, giving manual and scheduled runs the same persistent log format.
- Let the service fail when Homekeep returns a failure status.

Proposed timer policy: daily calendar execution, with exact time still to choose; `Persistent=true` to catch up when the timer becomes active after missing a schedule; no deliberate wake from suspend; no lingering setup initially. Logged-out execution is therefore not promised.

Persistent timers track missed activations, not successful backups. A failed run is logged and the next scheduled invocation tries again after rclone's own retries finish. Network availability must be handled as a runtime condition, not assumed from a systemd ordering dependency. Battery-power policy remains open.

Systemd avoids starting another instance of an already-running service, but the application lock is still needed for direct CLI invocations. Enabling the timer is deferred until the manual workflow works reliably.

## Verification before implementation is considered complete

Use Bun's test tooling for meaningful behavior tests, plus a separate TypeScript check. Follow the repository's hook policy before manual linting or formatting.

- Validate malformed configuration, unknown keys, missing paths, and paths escaping the home root.
- Exercise argument construction with spaces and shell metacharacters without invoking a shell.
- Use temporary local rclone destinations to verify selection filters, nested paths, exclusions, unusual names, and preservation of destination-only files.
- Verify that dry runs leave destination contents unchanged.
- Exercise success, no-op completion, partial failure, cancellation, lock contention, and log-write failure with a controlled subprocess.
- Verify log retention only removes eligible Homekeep logs and that runtime artifacts are excluded from backup.
- Verify service unit syntax and its environment separately before a user-authorized scheduled run.

Do not use personal Google Drive data as an automated test fixture. Document setup, configuration, copy semantics, symlink limitations, logging, and scheduling alongside the eventual implementation.

## References

- [Zod validation and inferred types](https://zod.dev/basics)
- [Bun TOML parsing](https://bun.com/docs/runtime/toml)
- [rclone copy semantics](https://rclone.org/commands/rclone_copy/)
- [rclone filtering](https://rclone.org/filtering/)
- [rclone logging and command options](https://rclone.org/docs/)
- [systemd service units](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
- [systemd timers](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)
