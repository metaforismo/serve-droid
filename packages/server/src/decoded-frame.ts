import { randomBytes } from "node:crypto";

const SOCKET_OPEN = 1;
const MAX_BUFFERED_BYTES = 256 * 1024;
const FRAME_ID = /^[a-f0-9]{32}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MIN_WIDTH = 1;
const MAX_WIDTH = 2_048;
const MIN_QUALITY = 25;
const MAX_QUALITY = 95;
const MIN_FRAME_BYTES = 4;
const MIN_MAX_BYTES = 64 * 1024;
const MIN_TIMEOUT_MS = 25;
const MAX_TIMEOUT_MS = 5_000;

export const DECODED_FRAME_DEFAULT_WIDTH = 1_080;
export const DECODED_FRAME_DEFAULT_QUALITY = 75;
export const DECODED_FRAME_MAX_BYTES = 1_500_000;
export const DECODED_FRAME_TIMEOUT_MS = 1_000;
export const DECODED_FRAME_MAX_PAYLOAD = 2_100_000;

export interface DecodedFrameProvider {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
}

export interface DecodedFrameCaptureOptions {
  maxWidth?: number;
  quality?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface DecodedFrameCapture {
  data: Buffer;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  capturedAt: string;
}

interface NormalizedOptions {
  maxWidth: number;
  quality: number;
  maxBytes: number;
  timeoutMs: number;
}

interface PendingCapture extends NormalizedOptions {
  id: string;
  providers: Set<DecodedFrameProvider>;
  promise: Promise<DecodedFrameCapture | null>;
  resolve: (capture: DecodedFrameCapture | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DecodedFrameResponse {
  schemaVersion?: unknown;
  type?: unknown;
  id?: unknown;
  mimeType?: unknown;
  width?: unknown;
  height?: unknown;
  data?: unknown;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function normalizeOptions(options: DecodedFrameCaptureOptions): NormalizedOptions {
  return {
    maxWidth: boundedInteger(
      options.maxWidth ?? DECODED_FRAME_DEFAULT_WIDTH,
      MIN_WIDTH,
      MAX_WIDTH,
      "maxWidth",
    ),
    quality: boundedInteger(
      options.quality ?? DECODED_FRAME_DEFAULT_QUALITY,
      MIN_QUALITY,
      MAX_QUALITY,
      "quality",
    ),
    maxBytes: boundedInteger(
      options.maxBytes ?? DECODED_FRAME_MAX_BYTES,
      MIN_MAX_BYTES,
      DECODED_FRAME_MAX_BYTES,
      "maxBytes",
    ),
    timeoutMs: boundedInteger(
      options.timeoutMs ?? DECODED_FRAME_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "timeoutMs",
    ),
  };
}

function isStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

export function jpegDimensions(data: Buffer): { width: number; height: number } | null {
  if (
    data.length < MIN_FRAME_BYTES ||
    data[0] !== 0xff ||
    data[1] !== 0xd8 ||
    data[data.length - 2] !== 0xff ||
    data[data.length - 1] !== 0xd9
  ) {
    return null;
  }

  let offset = 2;
  while (offset + 3 < data.length) {
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    if (offset >= data.length) return null;
    const marker = data[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) return null;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return null;
    if (isStartOfFrame(marker)) {
      if (length < 7) return null;
      const height = data.readUInt16BE(offset + 3);
      const width = data.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

function decodeResponse(
  value: DecodedFrameResponse,
  pending: PendingCapture,
): DecodedFrameCapture | null {
  if (
    value.schemaVersion !== 1 ||
    value.type !== "decoded-frame" ||
    value.id !== pending.id ||
    value.mimeType !== "image/jpeg" ||
    !Number.isInteger(value.width) ||
    !Number.isInteger(value.height) ||
    typeof value.data !== "string"
  ) {
    return null;
  }

  const width = value.width as number;
  const height = value.height as number;
  if (width < 1 || width > pending.maxWidth || height < 1 || height > 8_192) return null;
  const maximumEncodedLength = Math.ceil(pending.maxBytes / 3) * 4;
  if (
    value.data.length < 4 ||
    value.data.length > maximumEncodedLength ||
    value.data.length % 4 !== 0 ||
    !BASE64.test(value.data)
  ) {
    return null;
  }

  const data = Buffer.from(value.data, "base64");
  if (
    data.length < MIN_FRAME_BYTES ||
    data.length > pending.maxBytes ||
    data.toString("base64") !== value.data
  ) {
    return null;
  }
  const dimensions = jpegDimensions(data);
  if (!dimensions || dimensions.width !== width || dimensions.height !== height) return null;
  return {
    data,
    mimeType: "image/jpeg",
    width,
    height,
    capturedAt: new Date().toISOString(),
  };
}

function requestBody(id: string, options: NormalizedOptions): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: "capture-decoded-frame",
    id,
    maxWidth: options.maxWidth,
    quality: options.quality,
    maxBytes: options.maxBytes,
  });
}

export class DecodedFrameBroker {
  readonly #providers = new Set<DecodedFrameProvider>();
  #pending: PendingCapture | undefined;

  public register(provider: DecodedFrameProvider): () => void {
    this.#providers.add(provider);
    return () => this.unregister(provider);
  }

  public unregister(provider: DecodedFrameProvider): void {
    this.#providers.delete(provider);
    const pending = this.#pending;
    if (!pending || !pending.providers.delete(provider)) return;
    if (pending.providers.size === 0) this.#finish(pending, null);
  }

  public capture(
    options: DecodedFrameCaptureOptions = {},
  ): Promise<DecodedFrameCapture | null> {
    if (this.#pending) return this.#pending.promise;
    const normalized = normalizeOptions(options);
    const providers = new Set(
      [...this.#providers].filter(
        (provider) =>
          provider.readyState === SOCKET_OPEN &&
          Number.isFinite(provider.bufferedAmount) &&
          provider.bufferedAmount >= 0 &&
          provider.bufferedAmount < MAX_BUFFERED_BYTES,
      ),
    );
    if (providers.size === 0) return Promise.resolve(null);

    const id = randomBytes(16).toString("hex");
    let resolveCapture: (capture: DecodedFrameCapture | null) => void = () => undefined;
    const promise = new Promise<DecodedFrameCapture | null>((resolve) => {
      resolveCapture = resolve;
    });
    const pending = {
      ...normalized,
      id,
      providers,
      promise,
      resolve: resolveCapture,
      timer: setTimeout(() => undefined, normalized.timeoutMs),
    } satisfies PendingCapture;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.#finish(pending, null), normalized.timeoutMs);
    pending.timer.unref();
    this.#pending = pending;

    const body = requestBody(id, normalized);
    for (const provider of [...providers]) {
      try {
        provider.send(body);
      } catch {
        pending.providers.delete(provider);
      }
    }
    if (pending.providers.size === 0) this.#finish(pending, null);
    return promise;
  }

  public receive(provider: DecodedFrameProvider, raw: string): boolean {
    let value: DecodedFrameResponse;
    try {
      value = JSON.parse(raw) as DecodedFrameResponse;
    } catch {
      return false;
    }
    if (value.type !== "decoded-frame" && value.type !== "decoded-frame-error") return false;
    const pending = this.#pending;
    if (
      !pending ||
      typeof value.id !== "string" ||
      !FRAME_ID.test(value.id) ||
      value.id !== pending.id ||
      !pending.providers.has(provider)
    ) {
      return true;
    }

    if (value.type === "decoded-frame-error") {
      pending.providers.delete(provider);
      if (pending.providers.size === 0) this.#finish(pending, null);
      return true;
    }

    const capture = decodeResponse(value, pending);
    if (capture) this.#finish(pending, capture);
    else {
      pending.providers.delete(provider);
      if (pending.providers.size === 0) this.#finish(pending, null);
    }
    return true;
  }

  public close(): void {
    this.#providers.clear();
    if (this.#pending) this.#finish(this.#pending, null);
  }

  #finish(pending: PendingCapture, capture: DecodedFrameCapture | null): void {
    if (this.#pending !== pending) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.providers.clear();
    pending.resolve(capture);
  }
}
