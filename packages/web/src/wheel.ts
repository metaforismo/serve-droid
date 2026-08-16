const LINE_HEIGHT_PX = 16;
const EDGE_MARGIN = 0.06;
const MAX_TRAVEL = 0.34;
const MIN_DELTA_PX = 6;
const AXIS_NOISE_RATIO = 0.22;

export interface WheelSwipeInput {
  deltaX: number;
  deltaY: number;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
}

export interface WheelSwipe {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  durationMs: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundCoordinate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function fitAxis(anchor: number, travel: number): [number, number] {
  const minimum = EDGE_MARGIN;
  const maximum = 1 - EDGE_MARGIN;
  let start = clamp(Number.isFinite(anchor) ? anchor : 0.5, minimum, maximum);
  let end = start + travel;

  if (end < minimum) {
    start += minimum - end;
    end = minimum;
  } else if (end > maximum) {
    start -= end - maximum;
    end = maximum;
  }

  return [clamp(start, minimum, maximum), clamp(end, minimum, maximum)];
}

export function wheelDeltaToPixels(
  delta: number,
  deltaMode: number,
  axisLengthPx: number,
): number {
  if (!Number.isFinite(delta)) return 0;
  const safeAxis = Number.isFinite(axisLengthPx) && axisLengthPx > 0 ? axisLengthPx : 1;
  if (deltaMode === 1) return delta * LINE_HEIGHT_PX;
  if (deltaMode === 2) return delta * safeAxis;
  return delta;
}

export function wheelDeltasToSwipe(input: WheelSwipeInput): WheelSwipe | null {
  const { deltaX, deltaY, width, height, anchorX, anchorY } = input;
  if (
    !Number.isFinite(deltaX) ||
    !Number.isFinite(deltaY) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  const magnitudePx = Math.hypot(deltaX, deltaY);
  if (magnitudePx < MIN_DELTA_PX) return null;

  let travelX = -clamp(deltaX / width, -MAX_TRAVEL, MAX_TRAVEL);
  let travelY = -clamp(deltaY / height, -MAX_TRAVEL, MAX_TRAVEL);
  const absoluteX = Math.abs(deltaX);
  const absoluteY = Math.abs(deltaY);

  if (absoluteX < absoluteY * AXIS_NOISE_RATIO) travelX = 0;
  if (absoluteY < absoluteX * AXIS_NOISE_RATIO) travelY = 0;

  const [x1, x2] = fitAxis(anchorX, travelX);
  const [y1, y2] = fitAxis(anchorY, travelY);
  if (Math.hypot(x2 - x1, y2 - y1) < 0.01) return null;

  const durationMs = Math.round(clamp(90 + Math.min(magnitudePx, 420) * 0.38, 90, 250));
  return {
    x1: roundCoordinate(x1),
    y1: roundCoordinate(y1),
    x2: roundCoordinate(x2),
    y2: roundCoordinate(y2),
    durationMs,
  };
}
