---
"serve-droid": patch
---

Verify persisted sessions through the authenticated session endpoint before reusing their PID, token, URL, or device identity, and discard stale or malformed state instead of allowing recycled process IDs to drive lifecycle actions.
