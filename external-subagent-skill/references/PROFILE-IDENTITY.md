# Browser identity boundary

The canonical Oracle-derived transport uses the dedicated persistent browser root
`~/.chatonsteroids/oracle-subagent/browser-profile` with nested Chrome profile `Default`. The
authorized ChatGPT account role is `subagent`. This identity is intentionally isolated from both
the shared MiniPC Oracle runtime and the owner's ordinary Chrome user-data root.

The ordinary Chrome root with `Profile 173` is reserved only for the deliberately selected
`legacy-electron` rollback transport. Oracle browser mode must never fall back to that profile,
copy it, or import its cookies/session state. If the dedicated `Default` profile is not signed in,
that is an owner login gate rather than permission to migrate another profile.

The logical route key `cos-subagent` and the connector names (`Chat On Steroids Core`,
`Desktop`, and `Plugins`) are roles/surfaces, not additional ChatGPT accounts.
