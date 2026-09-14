# Job protocol

A job directory contains:

- `prompt.md` — owner-only (`0600`) task input copied by the caller and bound by SHA-256 in
  `meta.json`. The file is intentionally writable by its owner; integrity is checked with
  `O_NOFOLLOW`, regular-file/size validation, and the stored hash before provider dispatch.
- `meta.json` — job id, optional model/reasoning, connector name, transport, timeout, browser-profile pin.
- `dispatch.json` — written after the detached Oracle-derived worker starts; contains transport,
  local pid/host, connector name, and Oracle session id.
- `response.md` — full worker result written by the worker; its presence alone is never completion.
- `done.json` — last file written. `status` is `done` or `error`.

The caller treats only `done.json` as completion. `response.md` without `done.json` may still be in progress. Job directories are unique, so parallel callers do not share files.

Dispatch/runtime failures are fail-closed: the worker writes `done.json` with `status: error` rather
than leaving a blocking caller asleep indefinitely. A successful `done.json` also contains a
non-secret receipt with transport/host/connector/session/conversation evidence and a redacted
profile key when Oracle emitted one.

## Scheduling contract

- Submit with `run ... --async` first. This returns the durable job identity immediately.
- If the result is a dependency, call `join` and enter a wait-only state. Do not poll status,
  inspect runtime internals, or duplicate the worker's task while waiting.
- If the work is independent, continue useful work and join only when the result becomes a
  dependency.
- `join` waits on the job directory's completion event with a coarse filesystem fallback. The
  caller's model should be idle while it waits; the CLI is not permission to keep reasoning in a
  polling loop.

The default job root is `~/.chatonsteroids/jobs`. The only current override is the explicit
`--job-root <dir>` CLI option. The source prompt may live elsewhere; only the copied durable job
files are part of the worker protocol.
