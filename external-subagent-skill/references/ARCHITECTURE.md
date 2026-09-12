# Architecture

The external agent never drives ChatGPT UI directly. It writes a local job and relaunches the already-installed Chat On Steroids app with `--cos-subagent-job=<jobDir>`. Electron's single-instance handoff delivers that argv to the primary process.

The primary process admits the task under a synthetic local external-prime identity, crosses the existing immediate swarm persistence barrier, then asks the existing broker/bridge to open a normal Chat On Steroids worker. The companion extension owns browser delivery and conversation binding exactly as it does for workers spawned from a ChatGPT prime.

The browser launch is pinned to the configured Chromium profile directory. On this Mac the authorized live ChatGPT profile is `Profile 86`; the skill fails closed instead of silently falling back to another profile.

The worker receives only a short bootstrap containing absolute paths. The long prompt stays in `prompt.md`. The result stays in `response.md`; `done.json` is the completion fence. This avoids response scraping, copy buttons, streaming-state inference, and token-heavy prompt duplication.
