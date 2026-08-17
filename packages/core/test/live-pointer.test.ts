import { describe, expect, it } from "vitest";
import { AndroidActions, type AdbRunner, type RunResult } from "../src/index.js";

class FakeAdb implements AdbRunner {
  public readonly calls: string[][] = [];

  public async run(args: readonly string[]): Promise<RunResult> {
    this.calls.push([...args]);
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  public async capture(): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  public spawn(): never {
    throw new Error("not used");
  }
}

describe("live pointer ADB boundary", () => {
  it("rejects a streaming gesture as safe to fall back before issuing an ADB command", async () => {
    const adb = new FakeAdb();
    const actions = new AndroidActions(adb, "serial", async () => ({
      width: 1080,
      height: 2400,
      density: 420,
      orientation: "portrait",
    }));

    await expect(
      actions.gesture({
        points: [{ x: 0.5, y: 0.25 }],
        stream: { id: "0123456789abcdef", phase: "begin" },
      }),
    ).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
      details: { safeToFallback: true, phase: "begin" },
    });
    expect(adb.calls).toEqual([]);
  });
});
