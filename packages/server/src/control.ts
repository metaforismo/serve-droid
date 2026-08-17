import {
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  ScrcpyPointerId,
  type ScrcpyControlMessageWriter,
} from "@yume-chan/scrcpy";
import { ServeDroidError, type Gesture } from "@serve-droid/core";

const MAX_MOVE_MESSAGES = 120;
const MAX_GESTURE_POINTS = 64;
const MAX_GESTURE_DURATION_MS = 60_000;
const MAX_PENDING_ACTIONS = 8;
const TARGET_MOVE_INTERVAL_MS = 16;

interface VideoSize {
  width: number;
  height: number;
}

interface NormalizedPoint {
  x: number;
  y: number;
  durationMs?: number;
}

interface PixelPoint {
  x: number;
  y: number;
}

type TouchMessage = Parameters<ScrcpyControlMessageWriter["injectTouch"]>[0];
type TouchWriter = Pick<ScrcpyControlMessageWriter, "injectTouch">;
type Delay = (milliseconds: number) => Promise<void>;

export interface DevicePointerControl {
  tap(x: number, y: number): Promise<void>;
  swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number,
  ): Promise<void>;
  gesture(gesture: Gesture): Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertCoordinate(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ServeDroidError("INVALID_ARGUMENT", `${name} must be a number between 0 and 1.`);
  }
}

function assertDuration(value: number, name = "durationMs"): void {
  if (!Number.isInteger(value) || value < 1 || value > 60_000) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      `${name} must be an integer between 1 and 60000.`,
    );
  }
}

function validateGesture(gesture: Gesture): NormalizedPoint[] {
  if (!gesture || !Array.isArray(gesture.points)) {
    throw new ServeDroidError("INVALID_ARGUMENT", "A gesture must contain a points array.");
  }
  if (gesture.points.length < 2) {
    throw new ServeDroidError("INVALID_ARGUMENT", "A gesture requires at least two points.");
  }
  if (gesture.points.length > MAX_GESTURE_POINTS) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      `A gesture must not exceed ${MAX_GESTURE_POINTS} points.`,
    );
  }

  let totalDurationMs = 0;
  const points = gesture.points.map((point, index) => {
    if (!point || typeof point !== "object") {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        `gesture.points[${index}] must be an object.`,
      );
    }
    assertCoordinate(point.x, `gesture.points[${index}].x`);
    assertCoordinate(point.y, `gesture.points[${index}].y`);
    if (point.durationMs !== undefined) {
      assertDuration(point.durationMs, `gesture.points[${index}].durationMs`);
    }
    if (index > 0) totalDurationMs += point.durationMs ?? 100;
    return { x: point.x, y: point.y, durationMs: point.durationMs };
  });

  if (totalDurationMs > MAX_GESTURE_DURATION_MS) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      `A gesture must not exceed ${MAX_GESTURE_DURATION_MS} ms in total.`,
    );
  }
  return points;
}

function errorCause(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 160);
}

export class ScrcpyPointerController implements DevicePointerControl {
  #tail: Promise<void> = Promise.resolve();
  #pendingActions = 0;

  public constructor(
    private readonly writer: TouchWriter,
    private readonly getVideoSize: () => VideoSize | undefined,
    private readonly wait: Delay = delay,
  ) {}

  public async tap(x: number, y: number): Promise<void> {
    assertCoordinate(x, "x");
    assertCoordinate(y, "y");
    await this.#enqueue(() => this.#tap({ x, y }));
  }

  public async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs = 300,
  ): Promise<void> {
    assertCoordinate(x1, "x1");
    assertCoordinate(y1, "y1");
    assertCoordinate(x2, "x2");
    assertCoordinate(y2, "y2");
    assertDuration(durationMs);
    await this.#enqueue(() =>
      this.#path([
        { x: x1, y: y1 },
        { x: x2, y: y2, durationMs },
      ]),
    );
  }

  public async gesture(gesture: Gesture): Promise<void> {
    const points = validateGesture(gesture);
    await this.#enqueue(() => this.#path(points));
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.#pendingActions >= MAX_PENDING_ACTIONS) {
      throw new ServeDroidError(
        "TRANSPORT_FAILED",
        "Too many scrcpy pointer actions are queued.",
        { maxPendingActions: MAX_PENDING_ACTIONS },
      );
    }
    this.#pendingActions += 1;
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => undefined);
    return result.finally(() => {
      this.#pendingActions -= 1;
    });
  }

  #size(): VideoSize {
    const size = this.getVideoSize();
    if (
      !size ||
      !Number.isInteger(size.width) ||
      !Number.isInteger(size.height) ||
      size.width < 1 ||
      size.height < 1 ||
      size.width > 0xffff ||
      size.height > 0xffff
    ) {
      throw new ServeDroidError(
        "TRANSPORT_FAILED",
        "scrcpy control is not ready for pointer input.",
      );
    }
    return { ...size };
  }

  #pixel(point: NormalizedPoint, size: VideoSize): PixelPoint {
    return {
      x: Math.round(point.x * Math.max(0, size.width - 1)),
      y: Math.round(point.y * Math.max(0, size.height - 1)),
    };
  }

  #message(
    action: TouchMessage["action"],
    point: PixelPoint,
    size: VideoSize,
    pressure: number,
  ): TouchMessage {
    return {
      action,
      pointerId: ScrcpyPointerId.Finger,
      pointerX: point.x,
      pointerY: point.y,
      videoWidth: size.width,
      videoHeight: size.height,
      pressure,
      actionButton: AndroidMotionEventButton.None,
      buttons: AndroidMotionEventButton.None,
    };
  }

  async #inject(
    action: TouchMessage["action"],
    point: PixelPoint,
    size: VideoSize,
    pressure: number,
  ): Promise<void> {
    await this.writer.injectTouch(this.#message(action, point, size, pressure));
  }

  async #tap(point: NormalizedPoint): Promise<void> {
    const size = this.#size();
    const pixel = this.#pixel(point, size);
    let active = false;
    try {
      await this.#inject(AndroidMotionEventAction.Down, pixel, size, 1);
      active = true;
      await this.#inject(AndroidMotionEventAction.Up, pixel, size, 0);
      active = false;
    } catch (error) {
      if (active) {
        await this.#inject(AndroidMotionEventAction.Cancel, pixel, size, 0).catch(() => undefined);
      }
      throw new ServeDroidError("TRANSPORT_FAILED", "scrcpy pointer injection failed.", {
        cause: errorCause(error),
      });
    }
  }

  async #path(points: NormalizedPoint[]): Promise<void> {
    const size = this.#size();
    const segmentCount = points.length - 1;
    const maxStepsPerSegment = Math.max(1, Math.floor(MAX_MOVE_MESSAGES / segmentCount));
    let current = this.#pixel(points[0]!, size);
    let active = false;

    try {
      await this.#inject(AndroidMotionEventAction.Down, current, size, 1);
      active = true;

      for (let index = 1; index < points.length; index += 1) {
        const destination = this.#pixel(points[index]!, size);
        const durationMs = points[index]!.durationMs ?? 100;
        const steps = Math.max(
          1,
          Math.min(maxStepsPerSegment, Math.ceil(durationMs / TARGET_MOVE_INTERVAL_MS)),
        );
        const origin = current;
        for (let step = 1; step <= steps; step += 1) {
          await this.wait(durationMs / steps);
          current = {
            x: Math.round(origin.x + ((destination.x - origin.x) * step) / steps),
            y: Math.round(origin.y + ((destination.y - origin.y) * step) / steps),
          };
          await this.#inject(AndroidMotionEventAction.Move, current, size, 1);
        }
      }

      await this.#inject(AndroidMotionEventAction.Up, current, size, 0);
      active = false;
    } catch (error) {
      if (active) {
        await this.#inject(AndroidMotionEventAction.Cancel, current, size, 0).catch(() => undefined);
      }
      throw new ServeDroidError("TRANSPORT_FAILED", "scrcpy pointer injection failed.", {
        cause: errorCause(error),
      });
    }
  }
}
