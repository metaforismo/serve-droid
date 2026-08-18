---
"serve-droid": patch
---

Reject malformed UIAutomator XML explicitly and bound unterminated Logcat input so corrupted transport output cannot be mistaken for a valid hierarchy or retained indefinitely between newline and process boundaries.
