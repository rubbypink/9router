# Live Codex + OpenCode Smoke Receipt — 2026-07-22

## Verdict

**FAIL** for the requested combined smoke: the real OpenCode client did not
return output before the owner-mandated 45-second limit. The native Codex
Responses path and the Chat Completions affinity control both passed.

## Scope and Guardrails

- Owner-authorized live verification only. No product source was edited; no
  service was restarted; no release pointer, branch, commit, merge, or push was
  changed.
- No tests or builds were run because full SHA verification was explicitly
  skipped.
- The receipt deliberately omits all credential values, auth headers, raw
  request/response bodies, prompt-cache keys, account identifiers, session
  identifiers, and thread identifiers.

## Preflight

- Checkout revisions matched the expected state:
  - `9router`: `ca7d14fd9666a9283519de00fa800774d0ee9217`
  - `agents-platform`: `9496513dede2e11b883161afb162521ea21b250a`
- Canonical release link: `~/.local/share/9router/current` resolved to
  `releases/0.5.40-9trip.1`.
- Public port `20128` was owned by the agents-platform port-manager process
  with working directory `/Users/alextran119/Code/agents-platform`.
- `pnpm port-manager status` reported 9router `backendReady: true` and
  `ownership: owned`.
- No listener on public port `20128` was launched as
  `/opt/homebrew/bin/9router`; the installed command symlink existed but was
  not the public listener process.
- Sanitized `/api/health` values: `ok: true`, version
  `0.5.40-9trip.1`, upstream `0.5.40`, contract
  `session-affinity/v2`, affinity schema `3`, thread affinity enabled, and an
  enabled affinity store with no active/pending operations at observation time.
- Aggregate v2 binding count before the native Responses request: **73**
  (`threadRouteBindings + sessionModelBindings + sessionConnectionBindings`).

## Native Codex Responses

- Client auth was supplied internally from the existing configured local client
  path; no credential material was printed or retained.
- Authenticated model discovery succeeded and selected native-compatible model
  alias `codex`.
- One streaming `POST /v1/responses` was sent with a freshly generated,
  unlogged `thread-id` and a harmless prompt requesting exactly `OK`.
- Result: HTTP **200** on the first attempt; **2,855** SSE bytes; terminal
  `response.completed`; no terminal error; nonempty output; nonzero usage.
- Sanitized SSE event counts: `response.created`, `response.in_progress`,
  `response.output_item.added`, `response.content_part.added`,
  `response.output_text.delta`, `response.output_text.done`,
  `response.content_part.done`, `response.output_item.done`, and
  `response.completed` each occurred once.
- Aggregate v2 binding count changed **73 → 75** (**+2**).

## Actual OpenCode 1.18.4

- `opencode --version` returned `1.18.4`; `opencode run --help` documented
  both `--model` and `--session` continuation support.
- Installed configuration resolved an existing gateway model reference
  `9router/codex` without printing configuration values.
- Actual invocation used `opencode run --format json --model 9router/codex`
  with the same harmless `OK` request and a hard 45-second cap.
- Result: **FAIL**. The client exited with timeout signal status `142`, emitted
  zero JSON output bytes/events, and did not provide a safe session handle.
  Therefore no same-session continuation was possible and no client retry was
  performed.
- Aggregate v2 binding count observed around this failed client attempt:
  **75 → 77** (**+2**). A later intermediate observation reached 79 before the
  valid control; bounded evidence cannot attribute that asynchronous movement
  to a specific client operation, so it is not used as a success claim.

## Chat Completions Control

- Per owner direction, a closest Chat Completions control used internal local
  auth, model alias `codex`, both `x-session-affinity` and `X-Session-Id` set
  to one freshly generated unlogged value, non-streaming mode, and a 45-second
  timeout.
- First request: HTTP **200**, JSON response, nonempty assistant content,
  nonzero usage, no error; aggregate bindings **79 → 81** (**+2**).
- Immediate second request with the same affinity/session value: HTTP **200**,
  JSON response, nonempty assistant content, nonzero usage, no error;
  aggregate bindings **81 → 81** (**0**).
- This control distinguishes a healthy session-affinity gateway contract from
  the timed-out actual OpenCode CLI behavior; it does not turn the OpenCode
  scenario into a pass.

## Postflight

- Canonical release remained `0.5.40-9trip.1`; checkout revisions remained the
  expected values.
- The public listener ownership remained the managed agents-platform
  port-manager process; no lingering OpenCode client process was present.
- `pnpm port-manager status` still reported 9router `backendReady: true` and
  `ownership: owned`.
- `/api/health` remained `ok: true` with version `0.5.40-9trip.1`, upstream
  `0.5.40`, `session-affinity/v2`, affinity schema `3`, and no active/pending
  thread operations.
- Final v2 table aggregates: `threadRouteBindings: 69`,
  `sessionModelBindings: 6`, `sessionConnectionBindings: 6`; aggregate **81**.

## Follow-up Boundary

The managed gateway is healthy under both native Responses and same-session
Chat Completions controls. The remaining failure is specifically the installed
OpenCode CLI timing out before producing a response. Diagnose that client-side
hang separately; no service or release mutation was performed during this
smoke.

## Causal OpenCode Confirmation — 2026-07-22

**PASS.** This owner-authorized confirmation supersedes the prior timeout as
the current result for the actual OpenCode client scenario.

- Exactly one real `opencode run` command was issued from
  `/Users/alextran119/Code/9router` with OpenCode `1.18.4`, existing gateway
  configuration, model `9router/codex`, `--format json`, and a harmless prompt
  requesting `OK`. No model-list, retry, or other provider call was made.
- The client process was isolated in a validated temporary directory, with
  stdout and stderr captured separately, and was subject to a hard 120-second
  process-group cap. The temporary directory was removed before completion.
- Result: exit **0** after **72 seconds**, within the cap. Sanitized stdout
  contained **3** valid JSON events: `step_start`, `text`, and `step_finish`.
  The captured OpenCode log loop exited normally.
- The emitted `text` JSON event is the retained, payload-free evidence of a
  nonempty harmless output. The raw response text and all session/message IDs
  were discarded with the temporary directory.
- Aggregate v2 bindings changed **81 → 83** (**+2**), as expected for one new
  OpenCode session.
- Final postflight: canonical release `0.5.40-9trip.1`; 9router
  `backendReady: true` and `ownership: owned`; `/api/health` remained `ok:
  true` with `session-affinity/v2`, affinity schema `3`, enabled affinity
  store, and zero active/pending thread operations. No OpenCode client process
  remained.

This confirms the earlier 45-second failure was consistent with the observed
serialized title-plus-main request duration rather than a persistent gateway
or client compatibility failure.
