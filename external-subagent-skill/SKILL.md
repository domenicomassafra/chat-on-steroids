---
name: chat-on-steroids-subagent
description: "Delegate independent, blocking, long-running, or parallel work to a real ChatGPT worker orchestrated by the local Chat On Steroids app. Use when another agent would materially help, when the user explicitly asks to use Chat On Steroids, or when Chat On Steroids has local tools/capabilities the current agent lacks. Jobs are file-backed and can be awaited without scraping ChatGPT UI."
metadata:
  short-description: Delegate work to Chat On Steroids workers and collect file-backed results
---

# Chat On Steroids Subagent

Use the bundled `bin/cos-subagent.mjs`. Do not automate ChatGPT with pixel coordinates, AppleScript, AutoHotkey, or DOM scraping while the native Chat On Steroids broker path is available.

## Run a job

Put the full task in a Markdown file, then run:

```bash
node "<skill-dir>/bin/cos-subagent.mjs" run /absolute/path/to/prompt.md
```

The default is blocking: the command returns only after `done.json` exists, then prints the contents of `response.md`.

For work that can proceed in parallel:

```bash
node "<skill-dir>/bin/cos-subagent.mjs" run /absolute/path/to/prompt.md --async
```

Record the returned `jobDir`. Later:

```bash
node "<skill-dir>/bin/cos-subagent.mjs" status /absolute/path/to/jobDir
node "<skill-dir>/bin/cos-subagent.mjs" wait /absolute/path/to/jobDir
```

`join` is an alias of `wait`.

## Contract

- The CLI copies the supplied prompt to `<jobDir>/prompt.md`.
- Chat On Steroids creates the worker through its existing durable `agents` broker and companion-extension delivery path.
- The worker reads `prompt.md`, performs the work, writes `response.md`, then atomically writes `done.json`.
- The calling agent never needs to copy text from the ChatGPT page.
- Concurrent calls use distinct job directories.
- The authorized browser identity for this machine is pinned in `config/profile.json`; fail rather than silently using another profile.

## When to block

Use blocking mode when your next step depends on the result. Use `--async` when you have useful independent work to continue. Do not busy-loop; `wait` polls at a bounded interval and returns as soon as the job finishes.

## Safety / ownership

This skill is an external prime for one Chat On Steroids worker family. Workers do not spawn nested workers. Do not fabricate `done.json`, `response.md`, or a successful status. A missing/errored dispatch is a real failure and must be surfaced.

See `references/JOB-PROTOCOL.md` and `references/ARCHITECTURE.md` for the durable protocol and ownership model.
