# MCP integration

Run `serve-droid mcp` over newline-delimited JSON-RPC stdio. Each inbound message is capped at
1 MiB before the MCP SDK parser. A malformed line is reported as a transport error without being
joined to the next message; an oversized line is discarded through its newline and the transport
then resumes. Outbound writes honor Node stream backpressure and wait for `drain` instead of
accumulating an application-side output queue. Tools are bounded and explicit:

- `android_list_devices`, `android_start_session`, `android_stop_session`
- `android_observe`, `android_tap`, `android_tap_element`, `android_swipe`, `android_type_text`,
  `android_press_key`
- `android_manage_app`, `android_manage_permission`, `android_push_file`, `android_read_logs`

`android_observe` returns one JPEG image plus compact JSON metadata. It never emits raw XML or an
unbounded Logcat dump. Destructive app operations require `confirm: true`.

When an MCP caller includes a progress token, `android_manage_app` with `operation: "install"` and
`android_push_file` emit standard `notifications/progress` messages. Step `1/2` means the Android
install or push is active and `2/2` means it completed. These are monotonic operation steps, not a
percentage estimate. Callers that do not request progress receive no extra notifications, and the
normal tool result or error remains authoritative.

Prefer `android_tap_element` after observation. Its `selector` must contain exactly one exact
`id`, `resourceId`, `text`, or `contentDescription` value. The tool taps the center of the uniquely
matched normalized bounds. Missing matches return `ELEMENT_NOT_FOUND`; multiple matches return
`ELEMENT_AMBIGUOUS`. Neither case falls back to guessed coordinates.
