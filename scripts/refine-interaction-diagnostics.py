from pathlib import Path

source_path = Path("packages/core/src/interaction-errors.ts")
source = source_path.read_text(encoding="utf-8")

old_stop = '''      if (diagnostics.locked !== null && diagnostics.evidence.length > 0) break;'''
new_stop = '''      const conclusive =
        diagnostics.locked === false ||
        (diagnostics.locked === true && diagnostics.secure !== null);
      if (conclusive && diagnostics.evidence.length > 0) break;'''
if new_stop not in source:
    if old_stop not in source:
        raise SystemExit("diagnostic completion marker was not found")
    source = source.replace(old_stop, new_stop, 1)

old_message = '''function boundedMessage(value: string): string {
  const normalized = value.trim().replaceAll("\\u0000", "");
  if (!normalized) return "Android interaction failed.";
  return normalized.slice(0, MAX_ANDROID_MESSAGE);
}'''
new_message = '''function boundedMessage(value: string): string {
  const normalized = value
    // eslint-disable-next-line no-control-regex -- Intentionally strips ANSI CSI from untrusted Android output.
    .replace(/\\u001b\\[[0-?]*[ -/]*[@-~]/gu, "")
    // eslint-disable-next-line no-control-regex -- Intentionally replaces remaining C0 and DEL controls.
    .replace(/[\\u0000-\\u001f\\u007f]/gu, " ")
    .replace(/\\s+/gu, " ")
    .trim();
  if (!normalized) return "Android interaction failed.";
  return normalized.slice(0, MAX_ANDROID_MESSAGE);
}'''
if new_message not in source:
    if old_message not in source:
        raise SystemExit("bounded message marker was not found")
    source = source.replace(old_message, new_message, 1)
source_path.write_text(source, encoding="utf-8")

test_path = Path("packages/core/test/interaction-errors.test.ts")
tests = test_path.read_text(encoding="utf-8")
marker = '  it("returns DEVICE_LOCKED for a non-secure visible keyguard", async () => {'
secure_test = '''  it("continues diagnostics when the first dump proves a lock but not whether it is secure", async () => {
    const adb = new ScriptedAdb([
      { stdout: "", stderr: "input command failed", exitCode: 1 },
      {
        stdout: `KeyguardController:
  mKeyguardShowing=true
  mKeyguardGoingAway=false
  mAodShowing=false
`,
        stderr: "",
        exitCode: 0,
      },
      {
        stdout: `KeyguardStateMonitor
  mIsShowing=true
  mSimSecure=true
  mInputRestricted=true
`,
        stderr: "",
        exitCode: 0,
      },
    ]);

    await expect(
      runInteractionCommand(adb, ["shell", "input", "tap", "10", "20"], {
        serial: "device-1",
        operation: "tap",
      }),
    ).rejects.toMatchObject({
      code: "SECURE_SCREEN",
      details: { keyguard: { locked: true, secure: true } },
    });
    expect(adb.calls.map((call) => call.args)).toEqual([
      ["shell", "input", "tap", "10", "20"],
      ["shell", "dumpsys", "window", "policy"],
      ["shell", "dumpsys", "activity", "activities"],
    ]);
  });

'''
if 'it("continues diagnostics when the first dump proves a lock' not in tests:
    if marker not in tests:
        raise SystemExit("secure follow-up test marker was not found")
    tests = tests.replace(marker, secure_test + marker, 1)

marker_two = '  it("preserves the original failure when diagnostic commands throw", async () => {'
sanitize_test = '''  it("removes terminal control sequences from the bounded Android message", async () => {
    const adb = new ScriptedAdb([
      { stdout: "", stderr: "\\u001b[31minput failed\\u001b[0m\\nsecond line", exitCode: 1 },
      { stdout: unlockedKeyguardDump, stderr: "", exitCode: 0 },
    ]);

    await expect(
      runInteractionCommand(adb, ["shell", "input", "tap", "10", "20"], {
        serial: "device-1",
        operation: "tap",
      }),
    ).rejects.toMatchObject({
      code: "ADB_FAILED",
      message: "input failed second line",
    });
  });

'''
if 'it("removes terminal control sequences' not in tests:
    if marker_two not in tests:
        raise SystemExit("message sanitization test marker was not found")
    tests = tests.replace(marker_two, sanitize_test + marker_two, 1)
test_path.write_text(tests, encoding="utf-8")
