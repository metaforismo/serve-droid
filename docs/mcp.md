# MCP integration

Run `serve-droid mcp` over stdio. Tools are bounded and explicit:

- `android_list_devices`, `android_start_session`, `android_stop_session`
- `android_observe`, `android_tap`, `android_swipe`, `android_type_text`, `android_press_key`
- `android_manage_app`, `android_manage_permission`, `android_push_file`, `android_read_logs`

`android_observe` returns one JPEG image plus compact JSON metadata. It never emits raw XML or an
unbounded Logcat dump. Destructive app operations require `confirm: true`.
