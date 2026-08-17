import type { ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";
import { describe, expect, it } from "vitest";
import { ScrcpyPointerController } from "../src/control.js";

type TouchMessage = Parameters<ScrcpyControlMessageWriter["injectTouch"]>[0];

class RejectingWriter {
  public constructor(private readonly message: string) {}

  public async injectTouch(_message: TouchMessage): Promise<void> {
    throw new Error(this.message);
  }
}

describe("scrcpy input restriction errors", () => {
  it("maps explicit INJECT_EVENTS rejection to INPUT_RESTRICTED", async () => {
    const control = new ScrcpyPointerController(
      new RejectingWriter(
        "java.lang.SecurityException: Injecting to another application requires INJECT_EVENTS permission",
      ),
      () => ({ width: 100, height: 200 }),
      () => Promise.resolve(),
    );

    await expect(control.tap(0.5, 0.5)).rejects.toMatchObject({
      code: "INPUT_RESTRICTED",
      details: {
        transport: "scrcpy",
        evidence: "inject-events-permission",
        retryAfterUnlock: false,
      },
    });
  });

  it("keeps unrelated writer failures as TRANSPORT_FAILED", async () => {
    const control = new ScrcpyPointerController(
      new RejectingWriter("\u001b[31mcontrol socket closed\u001b[0m"),
      () => ({ width: 100, height: 200 }),
      () => Promise.resolve(),
    );

    await expect(control.tap(0.5, 0.5)).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
      details: { cause: "control socket closed" },
    });
  });
});
