# 9router session affinity and upgrade-safe release

## Objective

Implement provider-scoped session affinity for Codex and OpenCode, strict per-session round-robin assignment, persistent migration/TTL/rebind behavior, a versioned health contract, and an immutable port-manager deployment path based on upstream 9router 0.5.40.

## TODOs

- [x] Freeze and verify the existing custom baseline, then rebase it onto upstream 0.5.40 without losing owner changes.
- [x] Implement versioned session identity, provider/model binding separation, strict SQLite round-robin cursors, legacy migration, TTL cleanup, and controlled rebind.
- [x] Implement the generic session-affinity health/config contract and immutable custom release packaging.
- [x] Update agents-platform port-manager to require the custom routing contract and launch the immutable release path.
- [x] Record the owner-directed skip of full post-commit verification; retain the completed focused/build/package evidence and clean debug artifacts.

## Final Verification Wave

- [x] Record the owner-directed skip of a new full-SHA review wave; retain the independent pre-commit affinity and release gate verdicts.
- [x] Deploy the custom release through port-manager and smoke Codex Responses plus the actual OpenCode client and Chat Completions contract.

## Acceptance

- New sessions rotate A/B/A while repeat requests retain their provider account.
- Model changes within one provider retain the account; different providers bind independently; combos keep their selected model.
- Legacy bindings migrate without exposing raw identifiers; inactive bindings expire after 30 days by default.
- Disabled, deleted, locked, or retryably failing accounts rebind; unrelated 4xx responses do not.
- Codex `thread-id` and OpenCode `x-session-affinity`/`X-Session-Id` are supported with conflict detection and child-session isolation.
- Vanilla upstream artifacts fail the port-manager contract gate; the custom versioned artifact passes and can roll back.
- Tests, typecheck/build, package inspection, HTTP health, terminal Responses completion, and OpenCode-compatible chat all provide observable evidence.
