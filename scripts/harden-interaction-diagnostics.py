from pathlib import Path

source_path = Path("packages/core/src/interaction-errors.ts")
source = source_path.read_text(encoding="utf-8")

old_diagnostics = '''  for (const args of commands) {
    const result = await adb.run(args, {
      serial,
      timeoutMs: KEYGUARD_DIAGNOSTIC_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) continue;
    diagnostics = mergeKeyguardDiagnostics(
      diagnostics,
      parseKeyguardDiagnostics(`${result.stdout}\\n${result.stderr}`),
    );
    if (diagnostics.locked !== null && diagnostics.evidence.length > 0) break;
  }'''
new_diagnostics = '''  for (const args of commands) {
    try {
      const result = await adb.run(args, {
        serial,
        timeoutMs: KEYGUARD_DIAGNOSTIC_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) continue;
      diagnostics = mergeKeyguardDiagnostics(
        diagnostics,
        parseKeyguardDiagnostics(`${result.stdout}\\n${result.stderr}`),
      );
      if (diagnostics.locked !== null && diagnostics.evidence.length > 0) break;
    } catch {
      // Diagnostics are best-effort and must never replace the original interaction failure.
    }
  }'''
if new_diagnostics not in source:
    if old_diagnostics not in source:
        raise SystemExit("keyguard diagnostic loop marker was not found")
    source = source.replace(old_diagnostics, new_diagnostics, 1)

old_command = '''  const result = await adb.run(args, runOptions);
  if (result.exitCode === 0) return result.stdout;
  throw await diagnoseInteractionError(
    adb,
    options.serial,
    options.operation,
    resultFailureMessage(result),
  );'''
new_command = '''  let result: RunResult;
  try {
    result = await adb.run(args, runOptions);
  } catch (error) {
    throw await diagnoseInteractionError(adb, options.serial, options.operation, error);
  }
  if (result.exitCode === 0) return result.stdout;
  throw await diagnoseInteractionError(
    adb,
    options.serial,
    options.operation,
    resultFailureMessage(result),
  );'''
if new_command not in source:
    if old_command not in source:
        raise SystemExit("interaction command marker was not found")
    source = source.replace(old_command, new_command, 1)
source_path.write_text(source, encoding="utf-8")

test_path = Path("packages/core/test/interaction-errors.test.ts")
tests = test_path.read_text(encoding="utf-8")
old_constructor = "  public constructor(private readonly results: RunResult[]) {}"
new_constructor = "  public constructor(private readonly results: Array<RunResult | Error>) {}"
if new_constructor not in tests:
    if old_constructor not in tests:
        raise SystemExit("scripted ADB constructor marker was not found")
    tests = tests.replace(old_constructor, new_constructor, 1)

old_return = '    return this.results.shift() ?? { stdout: "", stderr: "", exitCode: 0 };'
new_return = '''    const result = this.results.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
    if (result instanceof Error) throw result;
    return result;'''
if new_return not in tests:
    if old_return not in tests:
        raise SystemExit("scripted ADB result marker was not found")
    tests = tests.replace(old_return, new_return, 1)

marker = '  it("keeps a generic failure when keyguard diagnostics are unavailable", async () => {'
extra_tests = '''  it("preserves the original failure when diagnostic commands throw", async () => {
    const adb = new ScriptedAdb([
      { stdout: "", stderr: "input command failed", exitCode: 1 },
      new Error("window dumpsys could not start"),
      new Error("activity dumpsys could not start"),
    ]);

    await expect(
      runInteractionCommand(adb, ["shell", "input", "tap", "10", "20"], {
        serial: "device-1",
        operation: "tap",
      }),
    ).rejects.toMatchObject({
      code: "ADB_FAILED",
      message: "input command failed",
      details: { operation: "tap", serial: "device-1" },
    });
    expect(adb.calls).toHaveLength(3);
  });

  it("normalizes a thrown initial ADB runner error through the same safe boundary", async () => {
    const adb = new ScriptedAdb([
      new Error("adb process could not start"),
      { stdout: unlockedKeyguardDump, stderr: "", exitCode: 0 },
    ]);

    await expect(
      runInteractionCommand(adb, ["shell", "input", "text", "private%smessage"], {
        serial: "device-1",
        operation: "type",
      }),
    ).rejects.toMatchObject({
      code: "ADB_FAILED",
      message: "adb process could not start",
      details: { operation: "type", serial: "device-1" },
    });
  });

'''
if 'it("preserves the original failure when diagnostic commands throw"' not in tests:
    if marker not in tests:
        raise SystemExit("diagnostic failure test marker was not found")
    tests = tests.replace(marker, extra_tests + marker, 1)
test_path.write_text(tests, encoding="utf-8")
