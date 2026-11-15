# homekeep

Back up selected home-directory files with their folder structure intact.

Homekeep wraps `rclone copy`, using a TOML config instead of repeated commands. It copies new and changed files, retains destination-only files, and streams diagnostic output to your terminal and a per-run log. It does not create historical versions. Renames can leave old names at the destination. Rsync support is deferred.

## Requirements and setup

Linux with Bun 1.4.4 or newer, rclone, and util-linux `flock`. Tested with Bun 1.4.4 and rclone 1.75.2 on Fedora 44. Configure and authenticate your named remote with rclone before using it in Homekeep.

```sh
bun install --frozen-lockfile
mkdir -p ~/.config/homekeep
cp config.example.toml ~/.config/homekeep/config.toml
```

Edit the copied configuration before running a backup. Keep your personal config outside this project; it can be tracked with chezmoi. Leave authentication in rclone's own config. Homekeep does not manage credentials.

## Configuration

```toml
destination = "my-drive:rclone-backup/my-device"
paths = ["Documents", "logseq/graphs", "backup-phone"]
exclude = ["**/node_modules/**", "**/__pycache__/**"]

[rclone]
transfers = 4
stats_seconds = 30

[logging]
enabled = true
retention_days = 30
```

`destination` and a nonempty `paths` list are required; other fields default to the values above, except `exclude` defaults to an empty list. Unknown keys are rejected, including in nested tables. Numbers must be positive integers.

Each selected path is literal and relative to your home directory. The destination represents that same root: `~/logseq/graphs/note.md` becomes `my-drive:rclone-backup/my-device/logseq/graphs/note.md`. Duplicate or overlapping selections do not transfer files twice. Select `.` to include the whole home directory, subject to exclusions.

Named destinations accept rclone remote names including spaces, Unicode letters/numbers, `+`, and `@`, such as `My Drive:backup`. Inline backend parameters remain unsupported.

Selections must exist before starting. Absolute paths, `..` components, glob metacharacters (`? * [ ] { }`), backslashes, surrounding whitespace, and control characters in selected paths are rejected. Symlinks and selected paths traversing symlinks are rejected; symlinks encountered inside selected directories are skipped by rclone. Empty directories are not copied. Live files are copied as rclone reads them; Homekeep does not take a filesystem or database snapshot.

Exclusions use [rclone patterns](https://rclone.org/filtering/) relative to home, not shell expansion or Git ignore syntax. Exclusions win over selections. For example, `/Documents/private/**` excludes that subtree and `**/node_modules/**` excludes dependency trees at any depth. Homekeep's state directory is always excluded when it is beneath home. `plan` displays the generated rules; `--dry-run` previews rclone's actual work.

A destination may also be an existing absolute local directory outside home (for example a mounted drive). It must not contain home either. Relative local destinations and inline rclone backend connection strings are rejected. Local rclone copies are available now; rsync is not implemented.

The config defaults to `$XDG_CONFIG_HOME/homekeep/config.toml`, or `~/.config/homekeep/config.toml` when unset or empty. State defaults to `$XDG_STATE_HOME/homekeep`, or `~/.local/state/homekeep`. XDG overrides must be absolute paths. Paths in TOML do not expand environment variables or `~`.

## Commands

Run from the project checkout:

```sh
bun run start plan
bun run start backup --dry-run
bun run start backup
bun run start backup --config /absolute/path/to/config.toml
```

`plan` validates configuration and source paths locally, without contacting the remote or creating state. Backup and dry-run commands contact rclone and create state. Dry runs leave destination files unchanged. Use `--help` on either command for options.

To use `homekeep` directly from fish or another shell, run `bun link` once in the checkout and make sure Bun's global bin directory is in your shell's PATH. Keep the checkout and its installed dependencies available. Alternatively, use an absolute invocation from any directory:

```sh
/absolute/path/to/bun /absolute/path/to/homekeep/src/cli.ts plan
```

Successful runs exit 0. Rclone failures retain its exit code; startup/configuration failures exit 1. Lock contention exits 75. SIGINT and SIGTERM cancellation exit 130 and 143 respectively; the child is stopped and reaped before releasing the lock. A child ignoring cancellation is killed after ten seconds. Rclone performs its own transfer retries; Homekeep adds no retry loop.

## Logs and state

Backup and dry-run output goes to stderr and, by default, a uniquely named `homekeep-<UTC timestamp>-<UUID>.log` file in the state directory's `logs/` subdirectory. Startup prints the log path. `plan` uses stdout and has no run log. Errors before logging starts appear on stderr.

Logs contain timestamped lifecycle messages, selected scope, rclone diagnostics, periodic transfer statistics, and final status. Rclone's JSON events are rendered as plain text without animated progress or terminal colors. Final summaries use rclone's structured counters when available; dry-run counters are not claims of uploaded data.

Logs may contain private filenames and destination paths. Newly created state/log directories use mode 0700; logs and filter files use 0600. Existing parent permissions are not modified. No credential or environment dump is generated. Logging failures warn and allow the transfer to continue; they do not turn successful transfers into failures.

Recognized Homekeep log files older than `retention_days` are removed when a run starts. Other files and symlinks are retained. Set `[logging] enabled = false` to disable file logging and retention; terminal output remains. State still holds a lock and a temporary filter file. Normal cleanup removes the filter; a hard crash can leave a `run-*` directory, which can be removed after confirming no backup is running. Never unlink `backup.lock` to clear contention: the persistent file is harmless, and kernel ownership is released when its holder exits.

Logs are diagnostic evidence; an interrupted run or missing final summary is not proof of successful backup. Use rclone's own tools for checking or restoring destination contents.

## Development

```sh
bun run typecheck
bun run test
```

Tests require rclone and flock. They use temporary home directories, local destinations, and controlled subprocesses; they do not access Google Drive. Type checking is separate from Bun's TypeScript execution.

The initial implementation follows [the design](docs/design.md).

## Optional scheduling

Example [user service](systemd/homekeep.service) and [timer](systemd/homekeep.timer) files are provided. Homekeep does not install or enable them. First configure your personal paths and verify a manual dry run and backup.

To set up scheduling yourself:

1. Copy the two unit files into `~/.config/systemd/user/`.
2. Edit the service's `ExecStart` to use your absolute Bun executable and checkout paths. The template assumes Bun lives at `%h/.bun/bin/bun`; replace `/absolute/path/to/homekeep/src/cli.ts`. Quote paths containing spaces. `%h` expands to your home directory; literal percent signs must be escaped as `%%` in unit files.
3. Confirm rclone and flock are in the explicit service PATH. The service uses Homekeep's default configuration location. Add `--config /absolute/path/to/config.toml` to `ExecStart` if needed. If you use custom XDG paths or `RCLONE_CONFIG`, set those explicitly with `Environment=`; fish startup configuration is not loaded.
4. Edit `OnCalendar` to your preferred schedule. The example uses 18:00 daily in local time.
5. Verify the units, reload the user manager, and enable the timer:

```sh
systemd-analyze --user verify ~/.config/systemd/user/homekeep.service ~/.config/systemd/user/homekeep.timer
systemctl --user daemon-reload
systemctl --user enable --now homekeep.timer
```

`Persistent=true` catches up missed calendar activations when the user timer becomes active. It does not track backup success or retry a failed run immediately. The timer does not deliberately wake a suspended laptop, no lingering is configured, and logged-out execution is not guaranteed. There is no battery-power restriction in the examples; they can run on battery. Rclone retries network failures within a run; afterward, failures wait for the next scheduled activation or manual retry.

The service allows long backups and stops its entire process group when cancelled. Standard output/error also go to the journal, in addition to Homekeep's file log. Systemd prevents duplicate activations of this service; Homekeep's lock also protects against concurrent direct CLI runs using the same state directory.

```sh
systemctl --user list-timers homekeep.timer
systemctl --user status homekeep.service
journalctl --user -u homekeep.service -f
systemctl --user stop homekeep.service
systemctl --user disable --now homekeep.timer
```

A completed oneshot service normally becomes inactive; inspect its result and logs for success or failure. Disabling the timer does not stop a backup already running. Uncatchable termination of a direct CLI process may leave an orphan rclone process; confirm it has stopped before restarting. Systemd's process-group cleanup covers service runs.
