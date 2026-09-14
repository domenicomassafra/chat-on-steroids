# Architecture

`Chat On Steroids Subagents` and DStack `oracle` are separate capabilities. DStack `oracle` keeps
its existing shared MiniPC route. This skill writes a local job and submits it to the local Chat On
Steroids app on the Mac Studio; it never forwards through
`ssh -T -- minipc /home/udodo/.local/bin/oracle-mcp-host`.

The canonical transport invokes the local Oracle-derived browser runtime against the owner-selected
ordinary Chrome user-data root and nested `Profile 173`. It does not launch a concurrent browser on
that root: it attaches only through the configured loopback DevTools endpoint, structurally verifies
the endpoint belongs to the expected user-data root, and uses the redacted `subagent` account mapping
as the identity receipt. Browser cookies, profile files, and session state are never copied.

For every prompt the Oracle browser adapter focuses an empty composer, types
only `@`, waits with DOM mutation evidence for exactly one visible exact native connector choice,
dispatches a trusted click to that DOM-resolved choice, proves that selection changed the composer,
then appends the task and uses the normal verified Send/answer-harvest pipeline. Missing,
ambiguous, or unproven connector UI fails closed before Send.

The durable job remains under `~/.chatonsteroids/jobs`: `prompt.md` is owner-only, hash-bound input;
`dispatch.json` proves an admitted Oracle-derived worker launch and records the pinned non-secret
Oracle source/executable provenance; `response.md` is the harvested answer; and atomically written
`done.json` is the sole completion fence.
