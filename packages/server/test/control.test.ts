import {
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  ScrcpyPointerId,
  type ScrcpyControlMessageWriter,
} from "@yume-chan/scrcpy";
import { describe, expect, it } from "vitest";
import { ScrcpyPointerController } from "../src/control.js";

type TouchMessage = Parameters<ScrcpyControlMessageWriter["injectTouch"]>[0];

class FakeWriter {
  public readonly messages: TouchMessage[] = [];
  public failOnAction: number | undefined;

  public async injectTouch(message: TouchMessage): Promise<void> {
    this.messages.push({ ...message });
    if (message.action === this.failOnAction) throw new Error("control socket closed");
  }
}

function actions(writer: FakeWriter): number[] {
  return writer.messages.map((message) => message.action);
}

describe("ScrcpyPointerController", () => {
  it("maps a normalized tap to one finger down/up pair", async () => {
    const writer = new FakeWriter();
    const control = new ScrcpyPointerController(writer, () => ({ width: 1080, height: 2400 }));

    await control.tap(0.5, 0.25);

    expect(actions(writer)).toEqual([AndroidMotionEventAction.Down, AndroidMotionEventAction.Up]);
    expect(writer.messages[0]).toMatchObject({
      pointerId: ScrcpyPointerId.Finger,
      pointerX: 540,
      pointerY: 600,
      videoWidth: 1080,
      videoHeight: 2400,
      pressure: 1,
      actionButton: AndroidMotionEventButton.None,
      buttons: AndroidMotionEventButton.None,
    });
    expect(writer.messages[1]?.pressure).toBe(0);
  });

  it("interpolates one bounded continuous swipe and preserves its duration", async () => {
    const writer = new FakeWriter();
    const waits: number[] = [];
    const control = new ScrcpyPointerController(
      writer,
      () => ({ width: 1000, height: 2000 }),
      (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    );

    await control.swipe(0.25, 0.8, 1, 0.1, 160);

    expect(actions(writer)[0]).toBe(AndroidMotionEventAction.Down);
    expect(actions(writer).at(-1)).toBe(AndroidMotionEventAction.Up);
    expect(
      actions(writer).filter((action) => action === AndroidMotionEventAction.Move),
    ).toHaveLength(10);
    expect(writer.messages.at(-1)).toMatchObject({ pointerX: 999, pointerY: 200, pressure: 0 });
    expect(waits.reduce((total, value) => total + value, 0)).toBeCloseTo(160);
  });

  it("keeps multi-point gestures on one continuous pointer lifecycle", async () => {
    const writer = new FakeWriter();
    const control = new ScrcpyPointerController(
      writer,
      () => ({ width: 400, height: 800 }),
      () => Promise.resolve(),
    );

    await control.gesture({
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.5, durationMs: 32 },
        { x: 0.9, y: 0.2, durationMs: 32 },
      ],
    });

    expect(
      actions(writer).filter((action) => action === AndroidMotionEventAction.Down),
    ).toHaveLength(1);
    expect(actions(writer).filter((action) => action === AndroidMotionEventAction.Up)).toHaveLength(
      1,
    );
    expect(
      actions(writer).filter((action) => action === AndroidMotionEventAction.Move),
    ).toHaveLength(4);
    expect(writer.messages.at(-1)).toMatchObject({ pointerX: 359, pointerY: 160 });
  });

  it("fails closed on invalid coordinates, durations, gestures, and missing stream size", async () => {
    const writer = new FakeWriter();
    const control = new ScrcpyPointerController(writer, () => ({ width: 100, height: 200 }));

    await expect(control.tap(-0.01, 0.5)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(control.swipe(0, 0, 1, 1, 0)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(control.gesture({ points: [{ x: 0, y: 0 }] })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });

    const unavailable = new ScrcpyPointerController(writer, () => undefined);
    await expect(unavailable.tap(0.5, 0.5)).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
    });
  });

  it("cancels an active pointer and surfaces a typed transport error on writer failure", async () => {
    const writer = new FakeWriter();
    writer.failOnAction = AndroidMotionEventAction.Move;
    const control = new ScrcpyPointerController(
      writer,
      () => ({ width: 100, height: 200 }),
      () => Promise.resolve(),
    );

    await expect(control.swipe(0, 0, 1, 1, 32)).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
      details: { cause: "control socket closed" },
    });
    expect(actions(writer).at(-1)).toBe(AndroidMotionEventAction.Cancel);
  });

  it("serializes independent callers onto the single scrcpy finger pointer", async () => {
    const messages: TouchMessage[] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let block = true;
    const writer = {
      async injectTouch(message: TouchMessage): Promise<void> {
        messages.push({ ...message });
        if (block) {
          block = false;
          await firstWrite;
        }
      },
    };
    const control = new ScrcpyPointerController(writer, () => ({ width: 100, height: 100 }));

    const first = control.tap(0.1, 0.1);
    const second = control.tap(0.9, 0.9);
    await Promise.resolve();
    expect(messages).toHaveLength(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(messages.map((message) => message.action)).toEqual([
      AndroidMotionEventAction.Down,
      AndroidMotionEventAction.Up,
      AndroidMotionEventAction.Down,
      AndroidMotionEventAction.Up,
    ]);
  });
});
