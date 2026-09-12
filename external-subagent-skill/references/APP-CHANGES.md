# App changes

Canonical local source: `/Users/domenico/Code/ChatOnSteroids`.

The owner branch adds:

1. `src/main/external-jobs.ts` — parses local job argv, validates `prompt.md`, durably spawns the worker through the existing broker, records `dispatch.json`, and writes an error fence on failed admission.
2. `src/main/index.ts` — accepts first-launch and Electron `second-instance` job argv without opening/focusing the CoS window, waits for the bridge listener before publishing the first external worker, then dispatches queued jobs.
3. `src/main/profile.ts` / `browser.ts` — supports an exact `COS_BROWSER_PROFILE_DIRECTORY` and forwards it as Chromium `--profile-directory=...`.
4. Tests cover argv parsing, durable admission, fail-closed job errors, profile validation, and Chromium launch pinning.
5. `src/main/external-jobs.ts` prefixes external-worker bootstraps with `@Chat On Steroids Core`; the browser extension resolves that text through ChatGPT's native connector picker and fails closed instead of treating a literal mention as connector authority.
6. Worker placement supports the synthetic external-prime owner by opening a fresh root ChatGPT conversation when no real home conversation UUID exists. Resume paths remain fail-closed.
