# Plan

- [x] Locate the real Chat On Steroids 2.0.8 source and reuse its broker/bridge instead of UI automation.
- [x] Resolve the requested live Chrome profile (`Profile 86`) from local evidence.
- [x] Add exact Chromium profile-directory launch support.
- [x] Add file-backed external-job admission to the existing agents broker.
- [x] Add cross-platform Node CLI semantics (`run`, `status`, `wait`, `join`).
- [x] Add focused tests and typecheck.
- [x] Run the full repository suite (3340 passed; 2 unrelated environment failures remain: bundled rg precedence and tunnel executable-bit fallback).
- [x] Build/package the modified app, verify its ad-hoc seal, and install it with a rollback bundle preserved.
- [x] Restart into the installed build and prove the live end-to-end path: CLI → Electron second instance → fresh ChatGPT worker → real `@Chat On Steroids Core` connector selection → `response.md` + terminal `done.json`.
- [x] Prove an external consumer can use the skill: OMP on `antigravity/gemini-3.8-flash` with medium thinking invoked the canonical skill and received `OMP_COS_SKILL_OK` through the live ChatGPT/Chat On Steroids path.
- [x] Project the canonical skill into the local agent skill directories for OMP, Pi, Hermes, OpenCode and the shared `.agents` surface without copying the source tree.
