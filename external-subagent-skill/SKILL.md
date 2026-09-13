---
name: chat-on-steroids-subagent
description: "Delegate independent, blocking, long-running, or parallel work to a real ChatGPT worker through the local Chat On Steroids Oracle-derived browser transport. Jobs are file-backed, select the requested ChatGPT connector natively, and can be awaited without caller-side UI scraping."
metadata:
  short-description: Delegate work to Chat On Steroids workers and collect file-backed results
---

# Chat On Steroids Subagents

Use the bundled `bin/cos-subagent.mjs`. The canonical transport is the local Oracle-derived browser
runtime using the dedicated persistent Chrome root/profile pinned in `config/profile.json`. It is
**not** the DStack `oracle` skill and must not route through the shared MiniPC Oracle service.

The default connector is `Chat On Steroids Core`. Override it only when the task requires another
connector:

```bash
node "<skill-dir>/bin/cos-subagent.mjs" run /absolute/path/to/prompt.md --async --connector "Chat On Steroids Core"
```

Connector selection is provider-owned: the paired extension types only `@`, waits for exactly
one visible exact native picker choice, clicks that choice through trusted browser input, proves the
composer changed to the connector, and only then appends the task. Never substitute a literal
`@Connector Name` string, fixed screen coordinates, AppleScript, or AutoHotkey.

## Fast path — run the job, do not debug the transport

Put the exact task in a Markdown file. Do **not** inspect Chat On Steroids source, app state,
logs, profiles, sessions, or job directories first. Those are troubleshooting steps only after
the CLI reports a real failure.

Always submit first so the durable `jobDir` is known immediately:

```bash
node "<skill-dir>/bin/cos-subagent.mjs" run /absolute/path/to/prompt.md --async
```

Then choose exactly one scheduling mode.

### Dependency mode — the next step needs this worker

```bash
node "<skill-dir>/bin/cos-subagent.mjs" join /absolute/path/to/jobDir
```

After starting `join`, **wait only**. Do not poll `status`, inspect logs, solve the delegated task
yourself, or start unrelated diagnostics. If the host terminal automatically backgrounds a long
command, use that host's native wait/read-output operation on the same process and remain in a
wait-only state until it exits. `join` sleeps on filesystem completion events and has a coarse
fallback; it is not a busy loop.

### Parallel mode — independent useful work exists

Keep working after `--async`. Record `jobDir`; call `join` only at the first point where the
worker result becomes a dependency. A cheap non-blocking inspection is available when genuinely
needed:

```bash
node "<skill-dir>/bin/cos-subagent.mjs" status /absolute/path/to/jobDir
```

`wait` is an alias of `join`. Plain `run <prompt.md>` remains a blocking compatibility form, but
agent callers should prefer the explicit submit-then-join flow above so an auto-backgrounding
shell can never hide the job identity.

## Contract

- The CLI copies the supplied prompt to `<jobDir>/prompt.md`.
- The CLI submits the job to the local Chat On Steroids worker facade on the Mac Studio.
- The facade dispatches a fresh Oracle-derived browser worker into the dedicated persistent browser
  root/profile only after the configured Oracle source commit and executable SHA-256 both match; it
  never invokes the shared MiniPC Oracle route or silently falls back to ordinary Chrome.
- The browser adapter selects `Chat On Steroids Core` natively, sends the task, and the worker writes
  `response.md`, then atomically writes `done.json`.
- The calling agent never needs to copy text from the ChatGPT page.
- Concurrent calls use distinct job directories.
- The authorized host/browser identity is pinned in `config/profile.json`; fail rather than silently
  using another host, browser profile, connector, or transport.
- `done.json.receipt` accepts connector identity only from Oracle's DOM-derived immediately-before-Send
  runtime evidence and accepts conversation identity only from Oracle's frozen post-submit
  conversation+target binding. It also records local host, transport, Oracle session id, and a
  redacted profile key/account role without exposing the account id or browser credentials.
- By default the durable job lives under `~/.chatonsteroids/jobs`, even if the source prompt was
  authored in `/tmp`; this keeps worker I/O inside the normal approved home root.

## When to block

Use dependency mode when your next step depends on the result. Use parallel mode only when there
is genuinely useful independent work. Do not turn dependency waiting into a second investigation:
one worker should not cause the caller to duplicate its work while waiting.

## Safety / ownership

This skill is an external prime for one Chat On Steroids worker family. Workers do not spawn nested
workers. Do not fabricate `done.json`, `response.md`, or a successful status. A missing/errored
dispatch is a real failure and must be surfaced.

See `references/JOB-PROTOCOL.md` and `references/ARCHITECTURE.md` for the durable protocol and ownership model.
