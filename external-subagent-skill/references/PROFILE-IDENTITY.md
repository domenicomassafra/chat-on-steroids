# Authorized Chrome profile

The live Chrome data contained two local profile directories that were ambiguous by display label alone: `Profile 86` and `Profile 87`.

Targeted ChatGPT-history evidence on 2026-09-12 resolved the authorized active profile:

- `Profile 86`: 1125 ChatGPT URL rows, with recent ChatGPT activity.
- `Profile 87`: 2 ChatGPT URL rows, much older activity.

Therefore this skill pins `Profile 86`. The app forwards the pin as Chromium `--profile-directory=Profile 86`; it does not depend on whichever Chrome window happened to have focus last and fails closed rather than silently selecting another profile.
