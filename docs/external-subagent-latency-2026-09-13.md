# External subagent latency repair — 2026-09-13

## Reproduction

A Gemini caller used `chat-on-steroids-subagent` to ask one ChatGPT worker to inspect the user's
Desktop. The external job was durably dispatched, but the overall interaction took roughly eight
minutes instead of behaving like a lightweight delegation.

The production log showed the earliest failures clearly:

- the CLI placed the durable job under `/tmp` because its default job root followed the source
  prompt directory;
- the bridge failed the invited worker when the fresh ChatGPT page had accepted the bootstrap but
  had not exposed its new conversation id before the command deadline;
- the worker then actually appeared and attempted the job after the broker had already declared
  it failed, so its first local calls were temporarily unattributed and paid the normal evidence
  wait;
- the caller's shell had backgrounded the nominally blocking CLI, and the model responded by
  polling/debugging the broker and duplicating the delegated Desktop inspection instead of waiting;
- the worker interpreted a broad Desktop inventory as permission to recursively inspect a very
  large subtree.

## Repair

- `external-subagent-skill/bin/cos-subagent.mjs` now places jobs under
  `~/.chatonsteroids/jobs` by default, returns the join command on async submit, and waits for
  `done.json` primarily through filesystem events with only a coarse fallback check.
- `SKILL.md` and `references/JOB-PROTOCOL.md` define two explicit scheduling modes: submit then
  wait-only `join` when the result is a dependency, or continue independent work and join only at
  the dependency boundary.
- `src/main/external-jobs.ts` inlines ordinary small job prompts directly into the worker bootstrap,
  removing the first prompt-file read and telling workers to preserve task scope rather than
  debug Chat On Steroids or recursively inventory large trees unless explicitly requested.
- `src/main/bridge.ts` no longer terminal-fails a fresh worker solely because its conversation id
  lags an already accepted native Send. The exact leased command remains recoverable through the
  existing `(agent, agentCommandId)` page-event path, while the existing deadline remains the
  fail-closed end if identity never materializes.
- `extension/content.js` no longer waits for a fresh post-Send conversation id with 80 chained
  500 ms sleeps. Chrome clamps background-tab timers, which allowed that nominal 40-second loop
  to outlive the claimed-command lease. It now wakes from native page/route evidence through the
  existing page-view observer and uses one bounded deadline only.

## Verification so far

- `npx vitest run test/external-jobs.test.ts test/bridge.test.ts` — 326/326 tests passed.
- `npm run typecheck` — passed.
- `node --check external-subagent-skill/bin/cos-subagent.mjs` — passed.

Package/install/live browser evidence is intentionally recorded only after rebuilding and running
the external job through the installed application; source tests alone do not prove that layer.

## Oracle-derived migration

The canonical transport is now being moved underneath `Chat On Steroids Subagents` rather than
continuing to grow a second browser-orchestration stack. The existing DStack `oracle` skill and its
shared MiniPC runtime are outside this migration and remain unchanged.

Implemented in the isolated owner-fork clone `/Users/domenico/Code/oracle-cos-subagent`:

- optional `connectorName` browser config plus CLI `--chatgpt-connector <name>`;
- ChatGPT-only validation while the default `null` path preserves standard Oracle behavior;
- provider-state propagation for both local browser submit paths;
- event-driven native connector selection: type only `@`, require one exact visible native choice,
  trusted click, prove selection, append task, then use normal verified Send;
- fail-closed errors for existing draft, missing/ambiguous connector choice, unproven selection, or
  missing task tail;
- fixed propagation of a named nested `manualLoginChromeProfile` from account resolution through
  the CLI browser config.
- hidden `--prompt-file <path>` support for the local transport so large external-agent tasks do not
  cross OS argv-size limits; the file path is redacted from Oracle performance traces.

Focused Oracle verification: 84/84 tests passed across `promptComposer.test.ts` and
`browserConfig.test.ts`; the production TypeScript build passed. A repository-wide `tsc --noEmit`
currently also reports pre-existing test typing drift unrelated to this patch (`SessionStore`
`readLogTail` mocks and an existing `accountId` browser-config test shape), so that result is not
being misreported as green.

The skill launcher now starts the local Oracle-derived worker with a dedicated `ORACLE_HOME_DIR`,
named/redacted account receipt, generic connector option (default `Chat On Steroids Core`), exact
Mac Studio host pin, atomic job result contract, and no legacy transport fallback.

Final Chat On Steroids repository verification after the transport/docs changes passed end-to-end:
privacy/history, notices/native-source checks, TypeScript, 3958 ordinary tests, and 2 MCP shutdown
tests all passed. The packaging-generated notices/icons were restored individually from `HEAD` and
are no longer part of the feature diff.

### First live smoke

Job `20260913T002519728Z-5b96f034` proved the new route reached the local Oracle CLI with:

- `host=mac-studio-dodo`;
- `transport=oracle-browser`;
- account role `subagent` with redacted profile key;
- `connectorName=Chat On Steroids Core`;
- no MiniPC SSH route.

It then failed before ChatGPT submission with `ECONNREFUSED` on the allocated local DevTools port.
The run had been pointed at the normal Chrome user-data root (`Profile 86`) while ordinary Chrome
was already running. Later Chrome `Local State` readback identified that profile as a separate test
identity, not the owner-selected ChatGPT account. The owner-selected profile
resolves to `Profile 173`.

### Second live smoke — rejected dedicated-profile boundary

Job `20260913T002832331Z-5a38d1a3` used the new dedicated profile root and proved:

- local host `mac-studio-dodo`;
- `transport=oracle-browser` and connector `Chat On Steroids Core`;
- `manualLoginProfileDir=~/.chatonsteroids/oracle-subagent/browser-profile`;
- nested Chrome profile `Default`;
- provider receipt `chatgpt` / `chatgpt-browser`, role `subagent`, redacted profile key;
- an independently running Chrome process with that exact user-data root and a local DevTools port.

The transport then waited for that separate profile to become authenticated and timed out without
submitting the sentinel. The owner rejected that identity: the canonical transport now uses
Oracle's ephemeral `--copy-profile` mode with normal Chrome `Profile 173`. Only a successful native
connector selection plus harvested `COS_SUBAGENT_ORACLE_OK` closes live acceptance.
