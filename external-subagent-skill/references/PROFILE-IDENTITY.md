# Browser identity boundary

The canonical Oracle-derived transport uses the owner-selected ordinary Chrome user-data root with
nested Chrome profile `Profile 173`. The authorized ChatGPT account role is `subagent`; the concrete
account identifier stays host-local and receipts expose only the role plus a redacted profile key.

Oracle browser mode must attach to the already-running profile through the configured local DevTools
endpoint. It must fail closed if the endpoint is absent, belongs to another user-data root, or remains
ambiguous. It must never copy cookies, clone the profile, import session state, launch a concurrent
Chrome on the same user-data root, route through the shared MiniPC Oracle, or silently fall back to
`legacy-electron`. The explicit rollback transport may use the same owner-selected identity, but it is
never selected automatically.

The logical route key `cos-subagent` and the connector names (`Chat On Steroids Core`,
`Desktop`, and `Plugins`) are roles/surfaces, not additional ChatGPT accounts.
