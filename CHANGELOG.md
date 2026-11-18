# Changelog

## 0.1.0 (2026-11-18)

- Initial release.
- `/route-check` command: folds `request/header` and `request/context` events into a route-compliance scorecard.
- Configurable `allow` / `deny` policy via the bundle patch row; default allowlist is the two free `opencode-go` routes.
- `--json` output for automation.
- Read-only by design: no prompts, tool bodies, credentials, network calls, or file writes.
- Fully offline test suite with synthetic event fixtures.
