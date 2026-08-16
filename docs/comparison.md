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
