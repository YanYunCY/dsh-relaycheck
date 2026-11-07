# Changelog

## Unreleased

### Fixed

- Target names that are `Object.prototype` keys (`constructor`, `toString`, …) were treated as configured targets, through `args.target` or `defaultTarget`, because lookup used `in`. They are now unknown targets.
- `keyEnv: ""` produced the message "environment variable  is not set"; `keyEnv` values such as `constructor` or `__proto__` counted as set (they resolve to inherited object members), so relaycheck was started anyway. The name is now validated first and the variable must hold a non-empty string.
- A malformed relaycheck report (`null`, an array, no or unknown `verdict`, non-array `groups`, `null` groups, non-numeric usage) crashed with a `TypeError` or produced a value that failed the output schema (`NaN` serialised as `null`, `verdict` missing). Such reports now give a readable error, and junk numeric fields fall back to `0` or are omitted.
- A tool call whose signal was already aborted still spawned relaycheck, which then ran to completion and spent relay tokens. It now rejects without starting a run.
- `timeoutSeconds` above about 24.8 days overflowed Node's 32-bit timer, which fires after 1 ms, so the run was killed at once. The timer is now clamped.
- A run killed by `timeoutSeconds` was reported as `relaycheck failed (exit 3)`. It is now reported as `relaycheck timed out after Ns`.
- Disposing the plugin did not stop a run in progress. It now aborts it.

### Hardened

- `baseUrl` is checked to be an `http(s)` URL before relaycheck is started; before, only relaycheck itself rejected a bad URL, after a process spawn.
- The key's exact value is redacted from the whole result value (headline, group summaries), not only from error messages, in addition to relaycheck's own redaction.
- stderr is redacted before it is truncated to its last 4000 bytes, so truncation cannot leave a fragment of the key behind.

### Tests

- 12 → 42 tests. New `test/hardening.test.js` covers config schema validation, target resolution edge cases, `keyEnv` validation, bad base URLs, argv construction, malformed reports, output schema conformance (dsh-tools `assertObjectJsonSchema` plus an explicit no-type-arrays check), key redaction, abort and timeout handling, connection-refused / hanging / non-JSON / key-echoing local relays, relaycheck's token-injecting mock, and plugin registration, approval gating and disposal in a real cordis + dsh-tools context. No real network or keys.

## 0.1.0

- Initial release.
