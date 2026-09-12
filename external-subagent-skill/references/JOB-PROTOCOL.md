# Job protocol

A job directory contains:

- `prompt.md` — immutable task input copied by the caller.
- `meta.json` — job id, optional model/reasoning, browser-profile pin.
- `dispatch.json` — written by Chat On Steroids after durable worker admission; contains `runId` and `workerId`.
- `response.md` — full worker result.
- `done.json` — last file written. `status` is `done` or `error`.

The caller treats only `done.json` as completion. `response.md` without `done.json` may still be in progress. Job directories are unique, so parallel callers do not share files.

Dispatch failures are fail-closed: Chat On Steroids writes `done.json` with `status: error` rather than leaving a blocking caller asleep indefinitely.
