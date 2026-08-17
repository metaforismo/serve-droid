import {
  AndroidMotionEventAction,
  ScrcpyPointerId,
  type ScrcpyControlMessageWriter,
} from "@yume-chan/scrcpy";
import { describe, expect, it } from "vitest";
import { ScrcpyPointerController } from "../src/control.js";

type TouchMessage = Parameters<ScrcpyControlMessageWriter["injectTouch"]>[0];

class FakeWriter {
  public readonly messages: TouchMessage[] = [];
  public failFirstMove = false;
  #failed = false;

  public async injectTouch(message: TouchMessage): Promise<void> {
    this.messages.push({ ...message });
    if (this.failFirstMove && !this.#failed && message.action === AndroidMotionEventAction.Move) {
      this.#failed = true;
      throw new Error("control socket closed");
    }
  }
}

function actions(writer: FakeWriter): number[] {
  return writer.messages.map((message) => message.action);
}

function pointerIds(writer: FakeWriter): bigint[] {
  return writer.messages.map((message) => message.pointerId);
}

describe("ScrcpyPointerController two-finger gestures", () => {
  it("uses two stable pointers, one shared clock, and reverse release order", async () => {
    const writer = new FakeWriter();
    const waits: number[] = [];
    let sizeReads = 0;
    const control = new ScrcpyPointerController(
      writer,
      () => {
        sizeReads += 1;
        return sizeReads === 1 ? { width: 1000, height: 2000 } : { width: 2000, height: 1000 };
      },
      (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    );

    await control.gesture({
      points: [
        { x: 0.25, y: 0.5 },
        { x: 0.1, y: 0.5, durationMs: 32 },
      ],
      secondaryPoints: [
        { x: 0.75, y: 0.5 },
        { x: 0.9, y: 0.5 },
      ],
    });

    expect(actions(writer)).toEqual([
      AndroidMotionEventAction.Down,
      AndroidMotionEventAction.Down,
      AndroidMotionEventAction.Move,
      AndroidMotionEventAction.Move,
      AndroidMotionEventAction.Move,
      AndroidMotionEventAction.Move,
      AndroidMotionEventAction.Up,
      AndroidMotionEventAction.Up,
    ]);
    expect(pointerIds(writer)).toEqual([1n, 2n, 1n, 2n, 1n, 2n, 2n, 1n]);
    expect(writer.messages[0]).toMatchObject({ pointerX: 250, pointerY: 1000, pressure: 1 });
    expect(writer.messages[1]).toMatchObject({ pointerX: 749, pointerY: 1000, pressure: 1 });
    expect(writer.messages.at(-2)).toMatchObject({ pointerX: 899, pointerY: 1000, pressure: 0 });
    expect(writer.messages.at(-1)).toMatchObject({ pointerX: 100, pointerY: 1000, pressure: 0 });
    expect(writer.messages.every((message) => message.videoWidth === 1000)).toBe(true);
    expect(writer.messages.every((message) => message.videoHeight === 2000)).toBe(true);
    expect(waits).toEqual([16, 16]);
    expect(sizeReads).toBe(1);
  });

  it("bounds generated moves per pointer for long gestures", async () => {
    const writer = new FakeWriter();
    const waits: number[] = [];
    const control = new ScrcpyPointerController(
      writer,
      () => ({ width: 100, height: 100 }),
      (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    );

    await control.gesture({
      points: [
        { x: 0.2, y: 0.5 },
        { x: 0.4, y: 0.5, durationMs: 60_000 },
      ],
      secondaryPoints: [
        { x: 0.8, y: 0.5 },
        { x: 0.6, y: 0.5 },
      ],
    });

    const moves = writer.messages.filter(
      (message) => message.action === AndroidMotionEventAction.Move,
    );
    expect(moves.filter((message) => message.pointerId === 1n)).toHaveLength(120);
    expect(moves.filter((message) => message.pointerId === 2n)).toHaveLength(120);
    expect(waits).toHaveLength(120);
    expect(waits.reduce((total, value) => total + value, 0)).toBeCloseTo(60_000);
  });

  it("cancels and clears both scrcpy pointers after a partial failure", async () => {
    const writer = new FakeWriter();
    writer.failFirstMove = true;
    const control = new ScrcpyPointerController(
      writer,
      () => ({ width: 100, height: 100 }),
      () => Promise.resolve(),
    );

    await expect(
      control.gesture({
        points: [
          { x: 0.2, y: 0.5 },
          { x: 0.4, y: 0.5, durationMs: 16 },
        ],
        secondaryPoints: [
          { x: 0.8, y: 0.5 },
          { x: 0.6, y: 0.5 },
        ],
      }),
    ).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
      details: { cause: "control socket closed" },
    });

    expect(actions(writer).slice(-3)).toEqual([
      AndroidMotionEventAction.Cancel,
      AndroidMotionEventAction.Up,
      AndroidMotionEventAction.Up,
    ]);
    expect(pointerIds(writer).slice(-3)).toEqual([2n, 2n, 1n]);

    await control.tap(0.5, 0.5);
    expect(pointerIds(writer).slice(-2)).toEqual([ScrcpyPointerId.Finger, ScrcpyPointerId.Finger]);
  });
});
