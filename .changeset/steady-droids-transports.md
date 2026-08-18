---
"serve-droid": patch
---

Return typed invalid-argument errors for malformed HTTP/control JSON and upload names, and close slow Logcat SSE streams with resumable event cursors instead of allowing response buffering to grow without bound.
