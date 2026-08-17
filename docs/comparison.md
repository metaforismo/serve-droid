# Comparison

| Tool                     | Center of gravity                     | serve-droid difference                             |
| ------------------------ | ------------------------------------- | -------------------------------------------------- |
| serve-sim                | iOS Simulator browser cockpit         | Android ADB/scrcpy, Logcat, semantic UI, and MCP   |
| scrcpy                   | Excellent native mirroring/control    | Shared browser, semantic observations, logs, MCP   |
| Android Studio           | Full Android IDE and device mirroring | Editor-neutral one-command local cockpit           |
| Maestro                  | Durable cross-platform UI test flows  | Interactive human-agent debugging session          |
| Appium                   | Broad WebDriver automation ecosystem  | Smaller local-first agent-oriented surface         |
| Android-MCP / mobile-mcp | Agent device actions                  | Human browser takeover plus one atomic observation |

serve-droid is not a replacement for these tools. It packages the development feedback loop they
leave fragmented. Its browser-first cockpit direction was inspired by
[serve-sim](https://github.com/EvanBacon/serve-sim), while the implementation and Android control
plane are independent.

Both cockpits keep latency-sensitive input on the live device transport instead of waiting to
reconstruct an entire drag after release. `serve-sim` forwards simulator touch/HID events;
serve-droid now sends authenticated scrcpy `DOWN`, coalesced `MOVE`, and `UP`/`CANCEL` phases while
the browser pointer is still moving. Wheel and trackpad bursts remain bounded touch swipes rather
than native Android scroll messages. Two-finger injection and native scroll-message forwarding are
separate future capabilities.
