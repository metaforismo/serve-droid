import { SCHEMA_VERSION, ServeDroidError } from "@serve-droid/core";

export const DEFAULT_ACTIVITY_LIMIT = 256;
const MAX_ACTIVITY_LIMIT = 1_024;
const MAX_ACTIVITY_STRING_BYTES = 256;

export type SessionActivityType =
  | "session-start"
  | "session-stop"
  | "recording-start"
  | "recording-stop"
  | "video-error"
  | "video-restart"
  | "display-size"
  | "screenshot"
  | "action"
  | "app"
  | "permission"
  | "file";

export type SessionActivityDetail = string | number | boolean | null;

export interface SessionActivityEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  cursor: string;
  timestamp: string;
  type: SessionActivityType;
  details: Record<string, SessionActivityDetail>;
}

export interface SessionActivityPage {
  schemaVersion: typeof SCHEMA_VERSION;
  events: SessionActivityEvent[];
  nextCursor: string;
  truncated: boolean;
}

const DETAIL_KEYS: Record<SessionActivityType, readonly string[]> = {
  "session-start": ["serial", "width", "height"],
  "session-stop": [],
  "recording-start": ["trigger", "serial", "width", "height"],
  "recording-stop": ["trigger"],
  "video-error": ["kind"],
  "video-restart": ["attempt", "maxAttempts"],
  "display-size": ["width", "height"],
  screenshot: ["source", "width", "height"],
  action: [
    "action",
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "durationMs",
    "pointCount",
    "textLength",
    "key",
    "orientation",
    "transport",
  ],
  app: ["operation", "packageName", "activity"],
  permission: ["operation", "permission", "packageName"],
  file: ["operation"],
};

function truncateUtf8(value: string): string {
  if (Buffer.byteLength(value) <= MAX_ACTIVITY_STRING_BYTES) return value;
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > MAX_ACTIVITY_STRING_BYTES) break;
    output += character;
    bytes += size;
  }
  return output;
}

function safeDetail(value: unknown): SessionActivityDetail | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  return truncateUtf8(value);
}

export function sanitizeActivityDetails(
  type: SessionActivityType,
  details: Record<string, unknown> = {},
): Record<string, SessionActivityDetail> {
  const safe: Record<string, SessionActivityDetail> = {};
  for (const key of DETAIL_KEYS[type]) {
    const value = safeDetail(details[key]);
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

function parseCursor(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      "Activity cursor must be a non-negative integer.",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ServeDroidError("INVALID_ARGUMENT", "Activity cursor exceeds the supported range.");
  }
  return parsed;
}

function cloneEvent(event: SessionActivityEvent): SessionActivityEvent {
  return { ...event, details: { ...event.details } };
}

export class SessionActivityBuffer {
  readonly #entries: SessionActivityEvent[] = [];
  readonly #limit: number;
  #nextCursor = 1;

  public constructor(limit = DEFAULT_ACTIVITY_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_LIMIT) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        `Activity limit must be between 1 and ${MAX_ACTIVITY_LIMIT}.`,
      );
    }
    this.#limit = limit;
  }

  public append(
    type: SessionActivityType,
    details: Record<string, unknown> = {},
  ): SessionActivityEvent {
    const event: SessionActivityEvent = {
      schemaVersion: SCHEMA_VERSION,
      cursor: String(this.#nextCursor++),
      timestamp: new Date().toISOString(),
      type,
      details: sanitizeActivityDetails(type, details),
    };
    this.#entries.push(event);
    if (this.#entries.length > this.#limit) {
      this.#entries.splice(0, this.#entries.length - this.#limit);
    }
    return cloneEvent(event);
  }

  public read(since = "0"): SessionActivityPage {
    const cursor = parseCursor(since);
    const firstCursor =
      this.#entries.length > 0 ? Number(this.#entries[0]!.cursor) : this.#nextCursor;
    return {
      schemaVersion: SCHEMA_VERSION,
      events: this.#entries
        .filter((event) => Number(event.cursor) > cursor)
        .map((event) => cloneEvent(event)),
      nextCursor: String(this.#nextCursor - 1),
      truncated: cursor < firstCursor - 1,
    };
  }
}
