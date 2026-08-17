import { AndroidMotionEventAction, type ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Gesture, GestureStreamPhase } from "../../core/src/index.js";
import { LIVE_POINTER_STREAM_TIMEOUT_MS, ScrcpyPointerController } from "../src/control.js";

type TouchMessage = Parameters<ScrcpyControlMessageWriter["injectTouch"]>[0];

class FakeWriter {
  public readonly messages: TouchMessage[] = [];

  public async injectTouch(message: TouchMessage): Promise<void> {
    this.messages.push({ ...message });
  }
}

class BlockingWriter extends FakeWriter {
  public blockMoves = false;
  #releaseMoves!: () => void;
  readonly #moveGate = new Promise<void>((resolve) => {
    this.#releaseMoves = resolve;
  });

  public override async injectTouch(message: TouchMessage): Promise<void> {
    await super.injectTouch(message);
    if (this.blockMoves && message.action === AndroidMotionEventAction.Move) {
      await this.#moveGate;
    }
  }

  public unblockMoves(): void {
    this.blockMoves = false;
    this.#releaseMoves();
  }
}

function live(id: string, phase: GestureStreamPhase, x: number, y: number): Gesture {
  return { points: [{ x, y }], stream: { id, phase } };
}

function actions(writer: FakeWriter): number[] {
  return writer.messages.map((message) => message.action);
}

afterEach(() => vi.useRealTimers());

describe("live scrcpy pointer streams", () => {
  it("forwards begin, move, and end immediately against one frame-size snapshot", async () => {
    const writer = new FakeWriter();
    let size = { width: 100, height: 200 };
    const control = new ScrcpyPointerController(writer, () => size);
    const id = "0123456789abcdef";

    await control.gesture(live(id, "begin", 0.25, 0.5));
    size = { width: 1000, height: 2000 };
    await control.gesture(live(id, "move", 0.5, 0.75));
    await control.gesture(live(id, "end", 1, 1));

    expect(actions(writer)).toEqual([
      AndroidMotionEventAction.Down,
      AndroidMotionEventAction.Move,
      AndroidMotionEventAction.Move,
      AndroidMotionEventAction.Up,
    ]);
    expect(writer.messages[0]).toMatchObject({
      pointerX: 25,
      pointerY: 100,
      videoWidth: 100,
      videoHeight: 200,
    });
    expect(writer.messages[1]).toMatchObject({ pointerX: 50, pointerY: 149 });
    expect(writer.messages.at(-1)).toMatchObject({ pointerX: 99, pointerY: 199, pressure: 0 });
  });

  it("keeps ownership exclusive and supports explicit cancellation", async () => {
    const writer = new FakeWriter();
    const control = new ScrcpyPointerController(writer, () => ({ width: 100, height: 100 }));
    const id = "0123456789abcdef";

    await control.gesture(live(id, "begin", 0.1, 0.1));
    await expect(control.tap(0.5, 0.5)).rejects.toMatchObject({ code: "TRANSPORT_FAILED" });
    await expect(control.gesture(live("fedcba9876543210", "move", 0.2, 0.2))).rejects.toMatchObject(
      { code: "INVALID_ARGUMENT" },
    );
    await control.gesture(live(id, "cancel", 0.1, 0.1));

    expect(actions(writer)).toEqual([
      AndroidMotionEventAction.Down,
      AndroidMotionEventAction.Cancel,
    ]);
  });

  it("cancels an abandoned stream after the bounded inactivity timeout", async () => {
    vi.useFakeTimers();
    const writer = new FakeWriter();
    const control = new ScrcpyPointerController(writer, () => ({ width: 100, height: 100 }));

    await control.gesture(live("0123456789abcdef", "begin", 0.5, 0.5));
    await vi.advanceTimersByTimeAsync(LIVE_POINTER_STREAM_TIMEOUT_MS);

    expect(actions(writer)).toEqual([
      AndroidMotionEventAction.Down,
      AndroidMotionEventAction.Cancel,
    ]);
  });

  it("reserves serialized timeout cleanup even when the public action queue is full", async () => {
    vi.useFakeTimers();
    const writer = new BlockingWriter();
    const control = new ScrcpyPointerController(writer, () => ({ width: 100, height: 100 }));
    const id = "0123456789abcdef";

    await control.gesture(live(id, "begin", 0.1, 0.1));
    writer.blockMoves = true;
    const pendingMoves = Array.from({ length: 8 }, (_, index) =>
      control.gesture(live(id, "move", 0.2 + index * 0.05, 0.2)),
    );
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(LIVE_POINTER_STREAM_TIMEOUT_MS);

    writer.unblockMoves();
    await Promise.all(pendingMoves);
    await control.gesture(live(id, "cancel", 0.55, 0.2));

    expect(actions(writer).at(-1)).toBe(AndroidMotionEventAction.Cancel);
  });
});
