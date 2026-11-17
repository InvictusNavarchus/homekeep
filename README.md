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
checkers = 8
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

Both commands accept `--transfers <number>`, `--checkers <number>`, and `--stats-seconds <number>`. Values must be positive integers. Precedence is **CLI override → TOML config → default** (4 transfers, 8 checkers, 30 seconds). Overrides affect only that invocation; they do not edit your config or change scheduled runs. The config itself must still be valid. `plan` shows the effective settings, and backup logs record them.

```sh
homekeep plan --transfers 10 --checkers 8
homekeep backup --transfers 10 --checkers 8 --stats-seconds 1
```

`plan` validates configuration and source paths locally, without contacting the remote or creating state. Backup and dry-run commands contact rclone and create state. Dry runs leave destination files unchanged. Use `--help` on either command for options.

To use `homekeep` directly from fish or another shell, run `bun link` once in the checkout and make sure Bun's global bin directory is in your shell's PATH. Keep the checkout and its installed dependencies available. Alternatively, use an absolute invocation from any directory:

```sh
/absolute/path/to/bun /absolute/path/to/homekeep/src/cli.ts plan
```

Successful runs exit 0. Rclone failures retain its exit code; startup/configuration failures exit 1. Lock contention exits 75. SIGINT and SIGTERM cancellation exit 130 and 143 respectively; the child is stopped and reaped before releasing the lock. A child ignoring cancellation is killed after ten seconds. Rclone performs its own transfer retries; Homekeep adds no retry loop.

## Logs and state

Backup and dry-run progress and successful completion go to stdout; warnings, errors, and cancellation go to stderr. Rclone JSON events are routed by severity: debug/info/notice go to stdout, warning and higher severities go to stderr. Unrecognized or unstructured child output keeps its original stream. Both streams are captured in a uniquely named `homekeep-<UTC timestamp>-<UUID>.log` file in the state directory's `logs/` subdirectory by default. Startup prints the log path. `plan` uses stdout and has no run log. Errors before logging starts appear on stderr.

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

Homekeep uses your user manager because its daily personal backup does not
require execution while logged out. It runs as your account and uses your backup
configuration and credentials. Installation needs no root privileges and does not
change account-wide lingering. If another tool has enabled lingering, this timer
can also run while you are logged out; that is supported, but not required.

First configure your personal paths and verify a manual dry run and backup. Unit
installation and activation are separate choices:

```sh
# Install/update units without enabling or starting a timer.
homekeep service install

# Explicitly enable and start the timer when ready.
systemctl --user enable --now homekeep.timer
```

The combined explicit opt-in remains available:

```sh
homekeep service install --time 06:00 --enable
```

The installer locates the current Bun executable and Homekeep checkout, discovers rclone/flock on PATH, validates the generated units with `systemd-analyze --user verify`, installs them under `$XDG_CONFIG_HOME/systemd/user` (normally `~/.config/systemd/user`), and reloads the user manager. Keep the checkout and dependencies available. No root privileges are needed. `--enable` enables and starts the timer; a missed schedule can cause an immediate backup. Without it, existing timer activation is unchanged.

After moving the checkout or changing Bun installations, register the command
again from the new/current checkout before regenerating the units. Use the Bun
installation intended for scheduled backups, and repeat any previous `--config`
options on `service install`:

```sh
cd /absolute/path/to/homekeep
bun link
homekeep service install
```

New installs default to 06:00 local time. Updates without `--time` preserve the existing timer file verbatim. Supplying `--time HH:MM` replaces the timer with the standard daily template at that time. The service file is regenerated on every install; use systemd drop-ins for persistent customizations. Drop-ins remain in force and can override generated settings. Non-regular unit files, including symlinks, are rejected rather than overwritten.

The installer captures the current XDG config/state locations and `RCLONE_CONFIG` path when set. Use `--config /absolute/path/config.toml` to select a custom Homekeep config; repeat this option on updates. Scheduled tuning belongs in TOML; `--transfers`, `--checkers`, and `--stats-seconds` are rejected for installation. Fish startup configuration is not loaded by the service. The command does not create your backup config or manage rclone credentials.

Units are validated before replacement. If reloading or enabling fails, the command exits unsuccessfully and reports the failure; installed files remain available for inspection and retry. It does not restart an in-progress backup.

If you track these files with chezmoi, capture them after installing or updating (adjust paths for custom XDG locations):

```sh
chezmoi add ~/.config/systemd/user/homekeep.service ~/.config/systemd/user/homekeep.timer
```

The [example service](systemd/homekeep.service) and [timer](systemd/homekeep.timer) remain available for manual installation. Both installation methods default to 06:00 local time; edit the example executable paths for your machine and adjust the schedule if desired.

`Persistent=true` catches up missed calendar activations when the user timer becomes active. A daily schedule does not guarantee exactly one successful backup per day. It does not track backup success or retry a failed run immediately. The timer does not deliberately wake a suspended laptop, no lingering is configured, and logged-out execution is not guaranteed. There is no battery-power restriction in the examples; they can run on battery. Rclone retries network failures within a run; afterward, failures wait for the next scheduled activation or manual retry.

The service allows long backups and stops its entire process group when cancelled. Standard output/error also go to the journal, in addition to Homekeep's file log. Systemd prevents duplicate activations of this service; Homekeep's lock also protects against concurrent direct CLI runs using the same state directory.

```sh
systemctl --user list-timers homekeep.timer
systemctl --user status homekeep.service
journalctl --user -u homekeep.service -f
systemctl --user stop homekeep.service
systemctl --user disable --now homekeep.timer
```

A completed oneshot service normally becomes inactive; inspect its result and logs for success or failure. Disabling the timer does not stop a backup already running. Uncatchable termination of a direct CLI process may leave an orphan rclone process; confirm it has stopped before restarting. Systemd's process-group cleanup covers service runs.

## Update local source and remove the installation

`bun link` exposes this checkout directly. Source edits affect later CLI and timer
invocations without a rebuild; dependency changes need `bun install --frozen-lockfile`.
Use a separate checkout for development if this one is scheduled. A running Bun
process is not restarted by `homekeep service install`. After moving the checkout
or Bun executable, run `bun link` from the new/current checkout, then regenerate
the units with the same config options used before. Alternatively, invoke the
checkout directly with `bun /absolute/path/to/homekeep/src/cli.ts service install`
and the previous config options; this regenerates units without repairing the
globally linked command.

To remove scheduling, first disable the timer:

```sh
systemctl --user disable --now homekeep.timer
systemctl --user status homekeep.service
```

Let an active backup finish before removing units; disabling the timer does not
cancel it. If cancellation is intended, use `systemctl --user stop homekeep.service`
and confirm the process has stopped. Once no backup is running, remove the base
units from the same XDG configuration location used for installation:

```sh
rm -- "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/homekeep.service" \
      "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/homekeep.timer"
systemctl --user daemon-reload
```

Inspect any `homekeep.service.d` or `homekeep.timer.d` directories separately;
these commands retain your customizations. From the linked checkout, `bun unlink`
removes the globally linked command. Scheduling removal alone leaves it usable.
Configuration, rclone credentials, logs, backup data, and account-wide lingering
are retained. No built-in service-uninstall command or data purge is provided.
