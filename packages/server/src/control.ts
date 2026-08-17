import {
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  ScrcpyPointerId,
  type ScrcpyControlMessageWriter,
} from "@yume-chan/scrcpy";
import {
  ServeDroidError,
  validateGesture,
  validateGestureStream,
  type Gesture,
  type ValidatedGestureStream,
} from "@serve-droid/core";

const MAX_MOVE_MESSAGES = 120;
const MAX_PENDING_ACTIONS = 8;
const TARGET_MOVE_INTERVAL_MS = 16;
const LIVE_POINTER_TIMEOUT_MS = 2_000;
const TWO_FINGER_POINTER_IDS = [1n, 2n] as const;

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

type PixelPair = [PixelPoint, PixelPoint];

interface LivePointerState {
  id: string;
  size: VideoSize;
  current: PixelPoint;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

type TouchMessage = Parameters<ScrcpyControlMessageWriter["injectTouch"]>[0];
type TouchWriter = Pick<ScrcpyControlMessageWriter, "injectTouch">;
type Delay = (milliseconds: number) => Promise<void>;

export interface DevicePointerControl {
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void>;
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

function errorCause(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 160);
}

export class ScrcpyPointerController implements DevicePointerControl {
  #tail: Promise<void> = Promise.resolve();
  #pendingActions = 0;
  #live: LivePointerState | undefined;

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
    const stream = validateGestureStream(gesture);
    if (stream) {
      await this.#enqueue(() => this.#stream(stream));
      return;
    }
    const validated = validateGesture(gesture);
    const secondaryPoints = validated.secondaryPoints;
    await this.#enqueue(() =>
      secondaryPoints
        ? this.#twoFingerPath(validated.points, secondaryPoints)
        : this.#path(validated.points),
    );
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.#pendingActions >= MAX_PENDING_ACTIONS) {
      throw new ServeDroidError("TRANSPORT_FAILED", "Too many scrcpy pointer actions are queued.", {
        maxPendingActions: MAX_PENDING_ACTIONS,
      });
    }
    this.#pendingActions += 1;
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => undefined);
    return result.finally(() => {
      this.#pendingActions -= 1;
    });
  }

  #enqueueCleanup(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => undefined);
    return result;
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
    pointerId: TouchMessage["pointerId"] = ScrcpyPointerId.Finger,
  ): TouchMessage {
    return {
      action,
      pointerId,
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
    pointerId: TouchMessage["pointerId"] = ScrcpyPointerId.Finger,
  ): Promise<void> {
    await this.writer.injectTouch(this.#message(action, point, size, pressure, pointerId));
  }

  #assertIdle(): void {
    if (this.#live) {
      throw new ServeDroidError(
        "TRANSPORT_FAILED",
        "A live scrcpy pointer stream is already active.",
      );
    }
  }

  async #tap(point: NormalizedPoint): Promise<void> {
    this.#assertIdle();
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
      throw this.#transportError(error);
    }
  }

  async #path(points: readonly NormalizedPoint[]): Promise<void> {
    this.#assertIdle();
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
        await this.#inject(AndroidMotionEventAction.Cancel, current, size, 0).catch(
          () => undefined,
        );
      }
      throw this.#transportError(error);
    }
  }

  async #twoFingerPath(
    primaryPoints: readonly NormalizedPoint[],
    secondaryPoints: readonly NormalizedPoint[],
  ): Promise<void> {
    this.#assertIdle();
    const size = this.#size();
    const segmentCount = primaryPoints.length - 1;
    const maxStepsPerSegment = Math.max(1, Math.floor(MAX_MOVE_MESSAGES / segmentCount));
    let current: PixelPair = [
      this.#pixel(primaryPoints[0]!, size),
      this.#pixel(secondaryPoints[0]!, size),
    ];
    const active = [false, false];

    try {
      for (const [pointerIndex, pointerId] of TWO_FINGER_POINTER_IDS.entries()) {
        await this.#inject(
          AndroidMotionEventAction.Down,
          current[pointerIndex]!,
          size,
          1,
          pointerId,
        );
        active[pointerIndex] = true;
      }

      for (let index = 1; index < primaryPoints.length; index += 1) {
        const destinations: PixelPair = [
          this.#pixel(primaryPoints[index]!, size),
          this.#pixel(secondaryPoints[index]!, size),
        ];
        const durationMs = primaryPoints[index]!.durationMs ?? 100;
        const steps = Math.max(
          1,
          Math.min(maxStepsPerSegment, Math.ceil(durationMs / TARGET_MOVE_INTERVAL_MS)),
        );
        const origins: PixelPair = [{ ...current[0] }, { ...current[1] }];
        for (let step = 1; step <= steps; step += 1) {
          await this.wait(durationMs / steps);
          current = origins.map((origin, pointerIndex) => {
            const destination = destinations[pointerIndex]!;
            return {
              x: Math.round(origin.x + ((destination.x - origin.x) * step) / steps),
              y: Math.round(origin.y + ((destination.y - origin.y) * step) / steps),
            };
          }) as PixelPair;
          for (const [pointerIndex, pointerId] of TWO_FINGER_POINTER_IDS.entries()) {
            await this.#inject(
              AndroidMotionEventAction.Move,
              current[pointerIndex]!,
              size,
              1,
              pointerId,
            );
          }
        }
      }

      for (
        let pointerIndex = TWO_FINGER_POINTER_IDS.length - 1;
        pointerIndex >= 0;
        pointerIndex -= 1
      ) {
        await this.#inject(
          AndroidMotionEventAction.Up,
          current[pointerIndex]!,
          size,
          0,
          TWO_FINGER_POINTER_IDS[pointerIndex],
        );
        active[pointerIndex] = false;
      }
    } catch (error) {
      await this.#abortTwoFinger(current, size, active);
      throw this.#transportError(error);
    }
  }

  async #abortTwoFinger(
    points: PixelPair,
    size: VideoSize,
    active: readonly boolean[],
  ): Promise<void> {
    const activeIndexes = active.flatMap((isActive, index) => (isActive ? [index] : []));
    const cancelIndex = activeIndexes.at(-1);
    if (cancelIndex === undefined) return;

    await this.#inject(
      AndroidMotionEventAction.Cancel,
      points[cancelIndex]!,
      size,
      0,
      TWO_FINGER_POINTER_IDS[cancelIndex],
    ).catch(() => undefined);

    for (let index = activeIndexes.length - 1; index >= 0; index -= 1) {
      const pointerIndex = activeIndexes[index]!;
      await this.#inject(
        AndroidMotionEventAction.Up,
        points[pointerIndex]!,
        size,
        0,
        TWO_FINGER_POINTER_IDS[pointerIndex],
      ).catch(() => undefined);
    }
  }

  async #stream(stream: ValidatedGestureStream): Promise<void> {
    if (stream.phase === "begin") await this.#beginLive(stream);
    else if (stream.phase === "move") await this.#moveLive(stream);
    else if (stream.phase === "end") await this.#endLive(stream);
    else await this.#cancelLive(stream.id, false);
  }

  async #beginLive(stream: ValidatedGestureStream): Promise<void> {
    this.#assertIdle();
    const size = this.#size();
    const current = this.#pixel(stream.point, size);
    try {
      await this.#inject(AndroidMotionEventAction.Down, current, size, 1);
      const state: LivePointerState = {
        id: stream.id,
        size,
        current,
        timeout: undefined,
      };
      this.#live = state;
      this.#armLiveTimeout(state);
    } catch (error) {
      await this.#inject(AndroidMotionEventAction.Cancel, current, size, 0).catch(() => undefined);
      throw this.#transportError(error, stream.phase);
    }
  }

  async #moveLive(stream: ValidatedGestureStream): Promise<void> {
    const state = this.#liveFor(stream.id);
    const current = this.#pixel(stream.point, state.size);
    try {
      await this.#inject(AndroidMotionEventAction.Move, current, state.size, 1);
      state.current = current;
      this.#armLiveTimeout(state);
    } catch (error) {
      await this.#abortLive(state);
      throw this.#transportError(error, stream.phase);
    }
  }

  async #endLive(stream: ValidatedGestureStream): Promise<void> {
    const state = this.#liveFor(stream.id);
    const current = this.#pixel(stream.point, state.size);
    try {
      if (current.x !== state.current.x || current.y !== state.current.y) {
        await this.#inject(AndroidMotionEventAction.Move, current, state.size, 1);
      }
      await this.#inject(AndroidMotionEventAction.Up, current, state.size, 0);
      this.#clearLive(state);
    } catch (error) {
      await this.#abortLive(state);
      throw this.#transportError(error, stream.phase);
    }
  }

  async #cancelLive(id: string, timedOut: boolean): Promise<void> {
    const state = this.#live;
    if (!state) return;
    if (state.id !== id) {
      throw new ServeDroidError("INVALID_ARGUMENT", "The live pointer stream id does not match.");
    }
    this.#clearLive(state);
    try {
      await this.#inject(AndroidMotionEventAction.Cancel, state.current, state.size, 0);
    } catch (error) {
      if (!timedOut) throw this.#transportError(error, "cancel");
    }
  }

  #liveFor(id: string): LivePointerState {
    if (!this.#live) {
      throw new ServeDroidError("TRANSPORT_FAILED", "No live scrcpy pointer stream is active.");
    }
    if (this.#live.id !== id) {
      throw new ServeDroidError("INVALID_ARGUMENT", "The live pointer stream id does not match.");
    }
    return this.#live;
  }

  #armLiveTimeout(state: LivePointerState): void {
    if (state.timeout) clearTimeout(state.timeout);
    const timeout = setTimeout(() => {
      void this.#enqueueCleanup(async () => {
        if (this.#live !== state || state.timeout !== timeout) return;
        await this.#cancelLive(state.id, true);
      }).catch(() => {
        if (this.#live === state && state.timeout === timeout) this.#clearLive(state);
      });
    }, LIVE_POINTER_TIMEOUT_MS);
    state.timeout = timeout;
    timeout.unref();
  }

  #clearLive(state: LivePointerState): void {
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = undefined;
    if (this.#live === state) this.#live = undefined;
  }

  async #abortLive(state: LivePointerState): Promise<void> {
    this.#clearLive(state);
    await this.#inject(AndroidMotionEventAction.Cancel, state.current, state.size, 0).catch(
      () => undefined,
    );
  }

  #transportError(error: unknown, phase?: string): ServeDroidError {
    return new ServeDroidError("TRANSPORT_FAILED", "scrcpy pointer injection failed.", {
      cause: errorCause(error),
      ...(phase ? { phase } : {}),
    });
  }
}

export const LIVE_POINTER_STREAM_TIMEOUT_MS = LIVE_POINTER_TIMEOUT_MS;
