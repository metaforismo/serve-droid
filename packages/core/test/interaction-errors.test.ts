import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  errorExitCode,
  inputRestrictionError,
  inputRestrictionEvidence,
  parseKeyguardDiagnostics,
  runInteractionCommand,
  type AdbRunner,
  type RunResult,
} from "../src/index.js";

class ScriptedAdb implements AdbRunner {
  public readonly calls: Array<{ args: string[]; serial?: string; timeoutMs?: number }> = [];

  public constructor(private readonly results: Array<RunResult | Error>) {}

  public async run(
    args: readonly string[],
    options: { serial?: string; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    this.calls.push({ args: [...args], ...options });
    const result = this.results.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
    if (result instanceof Error) throw result;
    return result;
  }

  public async capture(): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  public spawn(): ChildProcessWithoutNullStreams {
    throw new Error("spawn is not used by these tests");
  }
}

const secureKeyguardDump = `PhoneWindowManager
  KeyguardServiceDelegate
    showing=true
    showingAndNotOccluded=true
    inputRestricted=true
    secure=true
    enabled=true
`;

const unlockedKeyguardDump = `PhoneWindowManager
  KeyguardServiceDelegate
    showing=false
    showingAndNotOccluded=false
    inputRestricted=false
    secure=true
`;

describe("keyguard diagnostics", () => {
  it("parses a secure input-restricted keyguard from the scoped delegate block", () => {
    expect(parseKeyguardDiagnostics(secureKeyguardDump)).toEqual({
      showing: true,
      secure: true,
      inputRestricted: true,
      aodShowing: null,
      locked: true,
      evidence: [
        "KeyguardServiceDelegate.showing=true",
        "KeyguardServiceDelegate.showingAndNotOccluded=true",
        "KeyguardServiceDelegate.inputRestricted=true",
        "KeyguardServiceDelegate.secure=true",
      ],
    });
  });

  it("supports controller and legacy monitor fields without trusting unrelated booleans", () => {
    const diagnostics = parseKeyguardDiagnostics(`OtherService
  showing=true
KeyguardController:
  mKeyguardShowing=true
  mKeyguardGoingAway=false
  mOccluded=true
KeyguardStateMonitor
  mIsShowing=true
  mSimSecure=true
  mInputRestricted=true
`);

    expect(diagnostics).toMatchObject({
      showing: true,
      secure: true,
      inputRestricted: true,
      locked: true,
    });
    expect(diagnostics.evidence).not.toContain("OtherService.showing=true");
  });

  it("does not report a controller that is going away as locked", () => {
    expect(
      parseKeyguardDiagnostics(`KeyguardController:
  mKeyguardShowing=true
  mKeyguardGoingAway=true
  mAodShowing=false
`),
    ).toMatchObject({ showing: false, aodShowing: false, locked: false });
  });
});

describe("explicit input restriction classification", () => {
  it("recognizes AOSP INJECT_EVENTS permission failures", () => {
    const message =
      "java.lang.SecurityException: Injecting to another application requires INJECT_EVENTS permission";
    expect(inputRestrictionEvidence(message)).toBe("inject-events-permission");
    expect(inputRestrictionError(message, { transport: "scrcpy" })).toMatchObject({
      code: "INPUT_RESTRICTED",
      details: {
        transport: "scrcpy",
        evidence: "inject-events-permission",
        retryAfterUnlock: false,
      },
    });
  });

  it("recognizes an OEM or enterprise policy that explicitly disables injection", () => {
    expect(inputRestrictionEvidence("Input event injection is disabled by enterprise policy")).toBe(
      "input-injection-policy",
    );
    expect(inputRestrictionEvidence("Cannot inject input events on this device")).toBe(
      "input-injection-policy",
    );
  });

  it("does not reinterpret unrelated SecurityException messages", () => {
    expect(
      inputRestrictionEvidence(
        "java.lang.SecurityException: Permission denial while reading contacts provider",
      ),
    ).toBeNull();
  });
});

describe("interaction command errors", () => {
  it("returns SECURE_SCREEN only after a failed interaction and explicit keyguard evidence", async () => {
    const adb = new ScriptedAdb([
      { stdout: "", stderr: "input command failed", exitCode: 1 },
      { stdout: secureKeyguardDump, stderr: "", exitCode: 0 },
    ]);

    await expect(
      runInteractionCommand(adb, ["shell", "input", "tap", "10", "20"], {
        serial: "device-1",
        operation: "tap",
      }),
    ).rejects.toMatchObject({
      code: "SECURE_SCREEN",
      details: {
        operation: "tap",
        serial: "device-1",
        retryAfterUnlock: true,
        keyguard: { locked: true, secure: true, inputRestricted: true },
      },
    });
    expect(adb.calls.map((call) => call.args)).toEqual([
      ["shell", "input", "tap", "10", "20"],
      ["shell", "dumpsys", "window", "policy"],
    ]);
  });

  it("returns DEVICE_LOCKED for a non-secure visible keyguard", async () => {
    const adb = new ScriptedAdb([
      { stdout: "", stderr: "input command failed", exitCode: 1 },
      {
        stdout: `KeyguardServiceDelegate
  showing=true
  inputRestricted=true
  secure=false
`,
        stderr: "",
        exitCode: 0,
      },
    ]);

    await expect(
      runInteractionCommand(adb, ["shell", "input", "keyevent", "KEYCODE_HOME"], {
        serial: "device-1",
        operation: "key",
      }),
    ).rejects.toMatchObject({
      code: "DEVICE_LOCKED",
      details: { keyguard: { locked: true, secure: false } },
    });
  });

  it("returns INPUT_RESTRICTED immediately for explicit permission evidence", async () => {
    const adb = new ScriptedAdb([
      {
        stdout: "",
        stderr:
          "java.lang.SecurityException: Injecting to another application requires INJECT_EVENTS permission",
        exitCode: 1,
      },
    ]);

    await expect(
      runInteractionCommand(adb, ["shell", "input", "swipe", "1", "2", "3", "4"], {
        serial: "device-1",
        operation: "swipe",
      }),
    ).rejects.toMatchObject({
      code: "INPUT_RESTRICTED",
      details: { evidence: "inject-events-permission", retryAfterUnlock: false },
    });
    expect(adb.calls).toHaveLength(1);
  });

  it("preserves ADB_FAILED when keyguard evidence says unlocked and does not expose input args", async () => {
    const adb = new ScriptedAdb([
      { stdout: "", stderr: "input subsystem unavailable", exitCode: 1 },
      { stdout: unlockedKeyguardDump, stderr: "", exitCode: 0 },
    ]);

    const failure = runInteractionCommand(adb, ["shell", "input", "text", "private%smessage"], {
      serial: "device-1",
      operation: "type",
    }).catch((error: unknown) => error);

    await expect(failure).resolves.toMatchObject({
      code: "ADB_FAILED",
      message: "input subsystem unavailable",
      details: { operation: "type", serial: "device-1" },
    });
    expect(JSON.stringify(await failure)).not.toContain("private%smessage");
  });

  it("preserves the original failure when diagnostic commands throw", async () => {
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

  it("keeps a generic failure when keyguard diagnostics are unavailable", async () => {
    const adb = new ScriptedAdb([
      { stdout: "", stderr: "input command failed", exitCode: 1 },
      { stdout: "", stderr: "service unavailable", exitCode: 1 },
      { stdout: "", stderr: "service unavailable", exitCode: 1 },
    ]);

    await expect(
      runInteractionCommand(adb, ["shell", "input", "tap", "10", "20"], {
        serial: "device-1",
        operation: "tap",
      }),
    ).rejects.toMatchObject({ code: "ADB_FAILED", message: "input command failed" });
    expect(adb.calls).toHaveLength(3);
  });
});

describe("typed interaction error exit status", () => {
  it("uses the stable device-error status", () => {
    const restricted = inputRestrictionError(
      "Injecting to another application requires INJECT_EVENTS permission",
    )!;
    expect(errorExitCode(restricted)).toBe(20);
  });
});
