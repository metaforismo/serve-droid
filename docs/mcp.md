# MCP integration

Run `serve-droid mcp` over stdio. Tools are bounded and explicit:

- `android_list_devices`, `android_start_session`, `android_stop_session`
- `android_observe`, `android_tap`, `android_tap_element`, `android_swipe`, `android_type_text`,
  `android_press_key`
- `android_manage_app`, `android_manage_permission`, `android_push_file`, `android_read_logs`

`android_observe` returns one JPEG image plus compact JSON metadata. It never emits raw XML or an
unbounded Logcat dump. Destructive app operations require `confirm: true`.

Prefer `android_tap_element` after observation. Its `selector` must contain exactly one exact
`id`, `resourceId`, `text`, or `contentDescription` value. The tool taps the center of the uniquely
matched normalized bounds. Missing matches return `ELEMENT_NOT_FOUND`; multiple matches return
`ELEMENT_AMBIGUOUS`. Neither case falls back to guessed coordinates.
