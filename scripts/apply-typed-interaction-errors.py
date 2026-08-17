from pathlib import Path


def replace_once(path_name: str, old: str, new: str, label: str) -> None:
    path = Path(path_name)
    content = path.read_text(encoding="utf-8")
    if new in content:
        return
    if old not in content:
        raise SystemExit(f"{label} marker was not found in {path_name}")
    path.write_text(content.replace(old, new, 1), encoding="utf-8")


replace_once(
    "packages/core/src/index.ts",
    'export * from "./errors.js";\nexport * from "./logs.js";\n',
    'export * from "./errors.js";\nexport * from "./interaction-errors.js";\nexport * from "./logs.js";\n',
    "core export",
)

replace_once(
    "packages/core/src/actions.ts",
    'import { ServeDroidError } from "./errors.js";\n',
    'import { ServeDroidError } from "./errors.js";\nimport { runInteractionCommand } from "./interaction-errors.js";\n',
    "actions import",
)
replace_once(
    "packages/core/src/actions.ts",
    '''    await checkedRun(
      this.adb,
      ["shell", "input", "tap", pixel(x, display.width), pixel(y, display.height)],
      {
        serial: this.serial,
      },
    );''',
    '''    await runInteractionCommand(
      this.adb,
      ["shell", "input", "tap", pixel(x, display.width), pixel(y, display.height)],
      { serial: this.serial, operation: "tap" },
    );''',
    "tap input",
)
replace_once(
    "packages/core/src/actions.ts",
    '''    await checkedRun(
      this.adb,
      [
        "shell",
        "input",
        "swipe",
        pixel(x1, display.width),
        pixel(y1, display.height),
        pixel(x2, display.width),
        pixel(y2, display.height),
        String(durationMs),
      ],
      { serial: this.serial },
    );''',
    '''    await runInteractionCommand(
      this.adb,
      [
        "shell",
        "input",
        "swipe",
        pixel(x1, display.width),
        pixel(y1, display.height),
        pixel(x2, display.width),
        pixel(y2, display.height),
        String(durationMs),
      ],
      { serial: this.serial, operation: "swipe" },
    );''',
    "swipe input",
)
replace_once(
    "packages/core/src/actions.ts",
    '    await checkedRun(this.adb, ["shell", "input", "text", escaped], { serial: this.serial });',
    '    await runInteractionCommand(this.adb, ["shell", "input", "text", escaped], {\n      serial: this.serial,\n      operation: "type",\n    });',
    "text input",
)
replace_once(
    "packages/core/src/actions.ts",
    '    await checkedRun(this.adb, ["shell", "input", "keyevent", code], { serial: this.serial });',
    '    await runInteractionCommand(this.adb, ["shell", "input", "keyevent", code], {\n      serial: this.serial,\n      operation: "key",\n    });',
    "key input",
)

replace_once(
    "packages/core/src/service.ts",
    'import { ServeDroidError } from "./errors.js";\n',
    'import { ServeDroidError } from "./errors.js";\nimport { diagnoseInteractionError, runInteractionCommand } from "./interaction-errors.js";\n',
    "service import",
)
replace_once(
    "packages/core/src/service.ts",
    '''    const xml = await checkedRun(this.adb, ["exec-out", "uiautomator", "dump", "/dev/tty"], {
      serial: this.device.serial,
      timeoutMs: 10_000,
    });''',
    '''    const xml = await runInteractionCommand(
      this.adb,
      ["exec-out", "uiautomator", "dump", "/dev/tty"],
      {
        serial: this.device.serial,
        timeoutMs: 10_000,
        operation: "ui-hierarchy",
      },
    );''',
    "hierarchy interaction",
)
replace_once(
    "packages/core/src/service.ts",
    '''    const png = await this.adb.capture(["exec-out", "screencap", "-p"], {
      serial: this.device.serial,
      timeoutMs: 10_000,
    });''',
    '''    let png: Buffer;
    try {
      png = await this.adb.capture(["exec-out", "screencap", "-p"], {
        serial: this.device.serial,
        timeoutMs: 10_000,
      });
    } catch (error) {
      throw await diagnoseInteractionError(
        this.adb,
        this.device.serial,
        "screenshot",
        error,
      );
    }''',
    "screenshot interaction",
)

replace_once(
    "packages/server/src/control.ts",
    '  ServeDroidError,\n  validateGesture,\n',
    '  ServeDroidError,\n  inputRestrictionError,\n  validateGesture,\n',
    "scrcpy restriction import",
)
replace_once(
    "packages/server/src/control.ts",
    '''  #transportError(error: unknown, phase?: string): ServeDroidError {
    return new ServeDroidError("TRANSPORT_FAILED", "scrcpy pointer injection failed.", {
      cause: errorCause(error),
      ...(phase ? { phase } : {}),
    });
  }''',
    '''  #transportError(error: unknown, phase?: string): ServeDroidError {
    const cause = errorCause(error);
    const restricted = inputRestrictionError(cause, {
      transport: "scrcpy",
      ...(phase ? { phase } : {}),
    });
    if (restricted) return restricted;
    return new ServeDroidError("TRANSPORT_FAILED", "scrcpy pointer injection failed.", {
      cause,
      ...(phase ? { phase } : {}),
    });
  }''',
    "scrcpy transport error",
)

replace_once(
    "packages/core/src/interaction-errors.ts",
    '''  const locked =
    inputRestricted === true || showing === true || aodShowing === true
      ? true
      : inputRestricted === false && showing === false && aodShowing !== true
        ? false
        : null;''',
    '''  const locked =
    inputRestricted === true || showing === true || aodShowing === true
      ? true
      : showing === false && aodShowing !== true && inputRestricted !== true
        ? false
        : null;''',
    "unlocked keyguard consensus",
)
replace_once(
    "packages/core/src/interaction-errors.ts",
    ".toLocaleLowerCase()\n",
    ".toLowerCase()\n",
    "locale-independent classification",
)

replace_once(
    "packages/core/test/interaction-errors.test.ts",
    '  inputRestrictionError,\n',
    '  errorExitCode,\n  inputRestrictionError,\n',
    "exit-code import",
)
test_path = Path("packages/core/test/interaction-errors.test.ts")
tests = test_path.read_text(encoding="utf-8")
exit_test = '''

describe("typed interaction error exit status", () => {
  it("uses the stable device-error status", () => {
    const restricted = inputRestrictionError(
      "Injecting to another application requires INJECT_EVENTS permission",
    )!;
    expect(errorExitCode(restricted)).toBe(20);
  });
});
'''
if 'describe("typed interaction error exit status"' not in tests:
    test_path.write_text(tests + exit_test, encoding="utf-8")

replace_once(
    "docs/TODO.md",
    "- [ ] Add typed errors for locked/secure screens and OEM input restrictions.",
    "- [x] Add typed errors for locked/secure screens and OEM input restrictions.",
    "roadmap checkbox",
)
replace_once(
    "README.md",
    "npx serve-droid doctor\nnpx serve-droid avd list",
    "npx serve-droid doctor\nnpx serve-droid doctor --browser\nnpx serve-droid avd list",
    "browser doctor quick start",
)
replace_once(
    "README.md",
    '''npx serve-droid app deep-link 'servedroid://fixture/example'
```

Direct browser pointers now stream''',
    '''npx serve-droid app deep-link 'servedroid://fixture/example'
```

Failed ADB interactions preserve generic errors unless Android reports explicit keyguard or
input-policy evidence. See the [interaction failure diagnostics](docs/interaction-errors.md)
for the `DEVICE_LOCKED`, `SECURE_SCREEN`, and `INPUT_RESTRICTED` contract.

Direct browser pointers now stream''',
    "interaction error documentation link",
)
