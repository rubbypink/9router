# Live 9router Release Cutover Evidence

Date: 2026-07-22
Scope: owner-authorized activation of immutable `0.5.40-9trip.1`, transfer of backend ownership to the committed agents-platform port manager, exercised rollback, and cleanup. No source edits, merge, push, provider/LLM smoke, or full post-commit suite are in scope.

## Criterion 1 — Activation and recoverability

- Scenario: inspect the live immutable release immediately after the activation command that previously had a follow-up parser error.
- Command: `realpath ~/.local/share/9router/current` plus a read-only Node parser of `activation.json` and its enumerated backup files.
- Observable: `current` resolved to `releases/0.5.40-9trip.1`; record state was `active`; previous release was `releases/0.5.40-9trip.1-bootstrap`; DB, WAL, and SHM backups existed with nonzero recorded sizes.
- Artifact: this receipt and `~/.local/share/9router/activation.json` with its retained backup directory.

## Criterion 2 — Pre-cutover ownership and supervisor discovery

- Scenario: identify the running public manager, stale backend, and stale backend restart path without exposing config values or session identifiers.
- Command: `lsof -nP -iTCP:{20128,30128} -sTCP:LISTEN`, `ps -ww -o pid,ppid,pgid,lstart,command`, `pnpm port-manager status`, `launchctl print-disabled gui/$UID`, and `plutil -p ~/Library/LaunchAgents/com.9router.autostart.plist`.
- Observable: public `20128` was the `com.agents-platform.port-manager` process; backend `30128` was stale `/opt/homebrew/bin/9router`; status classified `9router` as `external`; the legacy `com.9router.autostart` LaunchAgent was disabled and absent from the active GUI domain.
- Artifact: this receipt and `/Users/alextran119/Code/9router/.debug-journal.md` until cleanup.

## Criterion 3a — Documented manager installer

- Scenario: load the committed, manifest-gated port-manager registry before releasing the stale backend port.
- Command: `pnpm port-manager:install` from `/Users/alextran119/Code/agents-platform` at commit `9496513dede2e11b883161afb162521ea21b250a`.
- Observable: the installer completed its documented LaunchAgent update (`Installed com.agents-platform.port-manager`); the outer diagnostic wrapper then exited nonzero only because it assigned to zsh's read-only `status` special parameter after the installer had already completed. Subsequent live manager ownership/health verification is recorded below.
- Artifact: `/tmp/agents-platform-port-manager-install-20260722.log` for this session and the installed `~/Library/LaunchAgents/com.agents-platform.port-manager.plist`.

## Criterion 3 — Completed manager handoff and H3 store readiness

- Scenario: verify the manager after its documented reinstall/cutover and inspect migration/store readiness using only aggregate data.
- Command: `pnpm port-manager status`, `curl --fail http://127.0.0.1:20128/api/health`, `lsof`/`ps` for `20128` and `30128`, and `stat`/`lsof` for `~/.9router/db/data.sqlite*`.
- Observable: manager `9router` status was `backendReady: true`, `ownership: owned`; `20128` belonged to manager PID `2726`; backend `30128` was a release-contained process with CWD `~/.local/share/9router/releases/0.5.40-9trip.1/app`; health exactly returned `session-affinity/v2`, `0.5.40`, `0.5.40-9trip.1`, and `threadAffinity: true`; affinity aggregate showed `activeThreads: 0`, `pendingOperations: 0`, and `waitingOperations: 0`; SQLite, WAL, and SHM existed and were open by that managed backend.
- Artifact: sanitized raw reads in `/tmp/9router-status-pre-rollback.json` and `/tmp/9router-health-pre-rollback.json` for this session; retained runtime database at `~/.9router/db`.

## Criterion 4 — Release CLI rollback

- Scenario: stop only the manager-owned backend, roll the release pointer and SQLite/WAL/SHM state back through the normal release CLI, then start the backend through the documented manager control socket.
- Command: `pnpm port-manager stop 9router`; `node cli/scripts/release-cli.js rollback`; `pnpm port-manager start 9router`.
- Observable: the manager confirmed the stop; `20128` remained listened on by PID `2726`; `30128` was no longer listening; manager status changed to `backendReady: false`, `ownership: none`. The release CLI switched `current` to `releases/0.5.40-9trip.1-bootstrap` and restored the activation backup exactly: `data.sqlite` `4,448,256` bytes, WAL `70,072` bytes, SHM `32,768` bytes.
- Artifact: `/tmp/9router-status-stopped.json`, `/tmp/9router-release-rollback.json`, `~/.local/share/9router/activation.json`, and the retained activation backup.

## Criterion 4a — Manager pointer reload requirement

- Scenario: start the stopped backend after rollback through the normal manager control socket.
- Command: `pnpm port-manager start 9router`.
- Observable: manager status and public health were healthy/owned with the exact manifest fingerprint, but the child command and CWD still resolved canonical `.1`. This proves the already-running manager resolves `current` when constructing its registry rather than when starting an individual child.
- Artifact: `/tmp/9router-status-bootstrap.json`, `/tmp/9router-health-bootstrap.json`, and process inspection showing the canonical binary command.

## Criterion 4b — Completed bootstrap rollback validation

- Scenario: reload the existing manager registry from the bootstrap pointer, then start the backend through its control socket after the CLI rollback.
- Command: `pnpm port-manager stop 9router`; `launchctl kickstart -k gui/$UID/com.agents-platform.port-manager`; `pnpm port-manager start 9router`; `pnpm port-manager status`; `curl --fail http://127.0.0.1:20128/api/health`; `lsof`/`ps` process inspection.
- Observable: manager listener returned on `20128` as PID `3545`; manager reported `backendReady: true`, `ownership: owned`; backend `30128` ran with CWD `~/.local/share/9router/releases/0.5.40-9trip.1-bootstrap/app` and parent command `.../0.5.40-9trip.1-bootstrap/bin/9router --skip-update --host 127.0.0.1 --port 30128`; health remained exact v2-compatible with `threadAffinity: true`.
- Artifact: `/tmp/9router-status-after-reload-interrupt.json`, `/tmp/9router-health-after-reload-interrupt.json`, and the retained bootstrap release.

## Criterion 5 — Canonical reactivation

- Scenario: stop the manager-owned bootstrap backend, activate canonical `.1` using the release CLI with a fresh DB/WAL/SHM backup, reload the manager registry, then start and validate canonical ownership and health.
- Command: `pnpm port-manager stop 9router`; `node cli/scripts/release-cli.js activate`; `launchctl kickstart -k gui/$UID/com.agents-platform.port-manager`; `pnpm port-manager start 9router`; status/health/listener/process readback.
- Observable: activation created backup `activation-1784738457593-9d512616-7ab2-4fa9-882b-63f0df7a96cc` with DB `4,448,256` bytes, WAL `82,432` bytes, SHM `32,768` bytes, then restored canonical `current`. Final `20128` manager PID was `3803`; `30128` backend PID was `3860`; manager status was `backendReady: true`, `ownership: owned`; the backend CWD and parent command resolve only to `~/.local/share/9router/releases/0.5.40-9trip.1`; health exactly returned `session-affinity/v2`, `0.5.40`, `0.5.40-9trip.1`, and `threadAffinity: true`; aggregate affinity counts remained zero active/pending/waiting operations.
- Artifact: `/tmp/9router-release-reactivate.json`, `/tmp/9router-status-final-after-interrupt.json`, `/tmp/9router-health-final-after-interrupt.json`, `~/.local/share/9router/activation.json`, and retained release/backup directories.

## Criterion 6 — Cleanup and retained artifacts

- Scenario: prove no stale global process or temporary release staging remains, remove only generated cutover artifacts, and retain all rollback-capable runtime artifacts.
- Command: process listing through a Node `execFileSync('ps', ...)` filter; release-root directory scan; `apply_patch` deletion of `9router-0.5.40-9trip.1.tgz`, `.debug-journal.md`, and its `.git/info/exclude` line.
- Observable: no `/opt/homebrew/bin/9router` or `/opt/homebrew/lib/node_modules/9router` process remained (the original stale PID `77908` no longer existed); no `.staging-*` or `.current-*` entry remained; canonical release, bootstrap release, activation backup, rollback backup, and reactivation backup were retained. Final live SQLite files existed with DB `4,448,256` bytes, WAL `465,592` bytes, SHM `32,768` bytes.
- Artifact: this receipt at `.omo/evidence/release-live-cutover-20260722.md`.

## Validation boundary

- Scenario: record intentionally excluded checks.
- Command: no provider/LLM request, source edit, commit, push, merge, or full post-commit suite was run.
- Observable: deployment proof is limited to the live local release/manager/health/store/rollback scenarios documented above.
- Artifact: this receipt.

## Criterion 7 — Final non-disruptive assertion

- Scenario: after cleanup, verify the public proxy, private backend, manager ownership, immutable health fingerprint, and cleanup invariants without restarting any process.
- Command: `realpath ~/.local/share/9router/current`; `pnpm port-manager status`; `curl --fail http://127.0.0.1:20128/api/health`; `lsof -nP -iTCP:{20128,30128} -sTCP:LISTEN`; cleanup assertions; `git diff --check` in both repositories.
- Observable: `current` remained canonical `.1`; manager was `backendReady: true`, `ownership: owned`; health remained `session-affinity/v2` / `0.5.40` / `0.5.40-9trip.1` / `threadAffinity: true`; PID `3803` listened on `20128`, PID `3860` on `30128`; journal/exclude/archive cleanup assertions passed; both diff checks were clean. Existing unrelated untracked `.omo` evidence remained preserved in both repositories.
- Artifact: this receipt and `/tmp/9router-status-final-cleanup.json` / `/tmp/9router-health-final-cleanup.json` for this session.
