# Plan

- [x] Locate the real Chat On Steroids 2.0.8 source and reuse its broker/bridge instead of UI automation.
- [x] Separate canonical Oracle identity (`~/.chatonsteroids/oracle-subagent/browser-profile` / `Default`) from explicit legacy rollback identity (ordinary Chrome `Profile 173`).
- [x] Add exact Chromium profile-directory launch support.
- [x] Add file-backed external-job admission to the existing agents broker.
- [x] Add cross-platform Node CLI semantics (`run`, `status`, `wait`, `join`).
- [x] Add focused tests and typecheck.
- [x] Run the full repository suite (3340 passed; 2 unrelated environment failures remain: bundled rg precedence and tunnel executable-bit fallback).
- [x] Build/package the modified app, verify its ad-hoc seal, install the current bundle, and remove obsolete application backups.
- [x] Preserve the historical legacy live proof while moving the canonical Oracle-derived transport onto its dedicated persistent browser profile; canonical acceptance remains governed by the current live gate.
- [x] Prove an external consumer can use the skill: OMP on `antigravity/gemini-3.8-flash` with medium thinking invoked the canonical skill and received `OMP_COS_SKILL_OK` through the live ChatGPT/Chat On Steroids path.
- [x] Project the canonical skill into the local agent skill directories for OMP, Pi, Hermes, OpenCode and the shared `.agents` surface without copying the source tree.
- [x] Pin the canonical Oracle donor to source commit `ffcac19056b90cf610e4b20ece04aee232f82423` and executable SHA-256 `e728723b6b92a7aee58a4376fa30ecb9f8bdd75af3ff353d93b087c7f120d6c3`; fail before spawn on mismatch.
- [x] Require DOM-observed connector evidence plus frozen conversation/target binding in the durable receipt, and fence post-job launch admission failures with atomic `done.json.status=error`.
