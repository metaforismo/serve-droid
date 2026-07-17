# Workflows

## Observe, act, verify

1. Call `android_observe` and inspect both the screenshot and elements.
2. Select exactly one element by resource ID, text, content description, or returned element ID.
3. Tap the center of its normalized bounds.
4. Call `android_observe` with the previous `nextLogCursor`.
5. Verify foreground app, semantic state, screenshot, and new logs.

Abort if the element is absent or ambiguous.

## Build, install, debug

1. Build an APK in the app repository.
2. Call `android_manage_app` with `operation: install` and the APK path.
3. Launch the package and observe.
4. Reproduce the problem semantically.
5. Read incremental logs; do not request unbounded system logs.
6. Apply the source fix, rebuild, reinstall, and repeat the same verification.

## Deep link

Call `android_manage_app` with `operation: deep-link`, the URL, and optional package. Observe and
verify the expected package and semantic element. Do not assume a successful ADB command means the
app handled the URL.
