import {
  AndroidActions,
  validateGesture,
  validateGestureStream,
  type AdbRunner,
  type Gesture,
  type RunResult,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

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
    throw new Error("spawn is not used by these tests");
  }
}

function actions(adb: FakeAdb): AndroidActions {
  return new AndroidActions(adb, "serial", async () => ({
    width: 1080,
    height: 1920,
    density: 420,
    orientation: "portrait",
  }));
}

const twoFingerGesture: Gesture = {
  points: [
    { x: 0.4, y: 0.5 },
    { x: 0.2, y: 0.5, durationMs: 240 },
  ],
  secondaryPoints: [
    { x: 0.6, y: 0.5 },
    { x: 0.8, y: 0.5 },
  ],
};

describe("two-finger gesture contract", () => {
  it("validates aligned paths and keeps one shared primary timeline", () => {
    expect(validateGesture(twoFingerGesture)).toBe(twoFingerGesture);
  });

  it("rejects mismatched paths and secondary durations", () => {
    expect(() =>
      validateGesture({
        ...twoFingerGesture,
        secondaryPoints: [{ x: 0.6, y: 0.5 }],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        message:
          "A two-finger gesture requires points and secondaryPoints to have the same length.",
      }),
    );

    expect(() =>
      validateGesture({
        ...twoFingerGesture,
        secondaryPoints: [
          { x: 0.6, y: 0.5 },
          { x: 0.8, y: 0.5, durationMs: 240 },
        ],
      } as Gesture),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        message:
          "secondaryPoints must not include durationMs; the primary points define the shared timeline.",
      }),
    );
  });

  it("does not allow a two-finger path inside one live pointer stream", () => {
    expect(() =>
      validateGestureStream({
        points: [{ x: 0.5, y: 0.5 }],
        secondaryPoints: [{ x: 0.6, y: 0.5 }],
        stream: { id: "abcdefghijklmnop", phase: "begin" },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        message: "A live pointer stream must not include secondaryPoints.",
      }),
    );
  });

  it("fails closed instead of approximating two fingers with sequential ADB swipes", async () => {
    const adb = new FakeAdb();

    await expect(actions(adb).gesture(twoFingerGesture)).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
      details: { safeToFallback: false, pointerCount: 2 },
    });
    expect(adb.calls).toHaveLength(0);
  });
});
