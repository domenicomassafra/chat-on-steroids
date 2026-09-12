# Canonical migration — 2026-09-12

The canonical project root is now:

`/Users/domenico/Code/ChatOnSteroids`

The application source is the repository root. The universal external-agent adapter lives in
`external-subagent-skill/` inside the same repository.

The previous application root `/Users/domenico/Code/CodeOnSteroids`, the linked 2.0.9 worktrees
`/Users/domenico/Code/.cos-v209` and `/Users/domenico/Code/.cos-v209merge`, and the Desktop skill
directory were migration sources only and are no longer operational roots.

Before removing the linked worktrees their uncommitted states were preserved as Git refs:

- `refs/archive/pre-canonical-v209-subagent-20260912` → `75d4bcd74866df39139dc6fa2972a7f38f3b4a85`
- `refs/archive/pre-canonical-v209-merge-20260912` → `d9435e99d08e8ee11c84667ec989530cfc0e3cad`

The second ref is the authoritative pre-migration WIP snapshot and was reapplied to
`owner/v209-merge` after the repository moved. The first ref preserves the older parallel 2.0.9
experiment; its profile/browser changes were verified to be already present in the merge tree.

Historical job metadata and browser logs may still mention the old Desktop path because they are
evidence of runs that happened before this migration. They are not executable configuration and
must not be rewritten to pretend those runs happened from the new path.
