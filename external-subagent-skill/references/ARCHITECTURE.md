# Architecture

`Chat On Steroids Subagents` and DStack `oracle` are separate capabilities. DStack `oracle` keeps
its existing shared MiniPC route. This skill writes a local job and submits it to the local Chat On
Steroids app on the Mac Studio; it never forwards through
`ssh -T -- minipc /home/udodo/.local/bin/oracle-mcp-host`.

The canonical transport invokes the local Oracle-derived browser runtime with a dedicated persistent
Chrome user-data root under `~/.chatonsteroids/oracle-subagent/browser-profile`, nested profile
`Default`. The ordinary Chrome `Profile 173` belongs only to the explicitly selected legacy rollback
path. Browser state is never copied between those identities.

For every prompt the Oracle browser adapter focuses an empty composer, types
only `@`, waits with DOM mutation evidence for exactly one visible exact native connector choice,
dispatches a trusted click to that DOM-resolved choice, proves that selection changed the composer,
then appends the task and uses the normal verified Send/answer-harvest pipeline. Missing,
ambiguous, or unproven connector UI fails closed before Send.

The durable job remains under `~/.chatonsteroids/jobs`: `prompt.md` is owner-only, hash-bound input;
`dispatch.json` proves an admitted Oracle-derived worker launch and records the pinned non-secret
Oracle source/executable provenance; `response.md` is the harvested answer; and atomically written
`done.json` is the sole completion fence.
