import {
  captureDecodedFrame,
  type DecodedFrameCapture,
  type DecodedFrameCaptureOptions,
} from "./screenshot.js";

const FRAME_ID = /^[a-f0-9]{32}$/u;
const MIN_WIDTH = 1;
const MAX_WIDTH = 2_048;
const MIN_QUALITY = 25;
const MAX_QUALITY = 95;
const MIN_MAX_BYTES = 64 * 1024;
const MAX_MAX_BYTES = 1_500_000;
const BASE64_CHUNK = 32 * 1024;

export interface DecodedFrameRequest {
  schemaVersion: 1;
  type: "capture-decoded-frame";
  id: string;
  maxWidth: number;
  quality: number;
  maxBytes: number;
}

export type DecodedFrameCaptureFunction = (
  options: DecodedFrameCaptureOptions,
) => Promise<DecodedFrameCapture | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

export function parseDecodedFrameRequest(value: unknown): DecodedFrameRequest | null {
  if (!isRecord(value) || value.type !== "capture-decoded-frame") return null;
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    !FRAME_ID.test(value.id) ||
    !integer(value.maxWidth, MIN_WIDTH, MAX_WIDTH) ||
    !integer(value.quality, MIN_QUALITY, MAX_QUALITY) ||
    !integer(value.maxBytes, MIN_MAX_BYTES, MAX_MAX_BYTES)
  ) {
    throw new Error("Decoded frame request is malformed.");
  }
  return value as unknown as DecodedFrameRequest;
}

function blobBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
    }
    return btoa(binary);
  });
}

function sendError(send: (message: string) => void, id: string, code: string): void {
  send(JSON.stringify({ schemaVersion: 1, type: "decoded-frame-error", id, code }));
}

export async function handleDecodedFrameRequest(
  raw: string,
  send: (message: string) => void,
  capture: DecodedFrameCaptureFunction = captureDecodedFrame,
): Promise<boolean> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(value) || value.type !== "capture-decoded-frame") return false;

  const candidateId = typeof value.id === "string" && FRAME_ID.test(value.id) ? value.id : null;
  let request: DecodedFrameRequest;
  try {
    request = parseDecodedFrameRequest(value)!;
  } catch {
    if (candidateId) sendError(send, candidateId, "INVALID_REQUEST");
    return true;
  }

  try {
    const frame = await capture({
      maxWidth: request.maxWidth,
      quality: request.quality,
      maxBytes: request.maxBytes,
    });
    if (!frame) {
      sendError(send, request.id, "FRAME_NOT_READY");
      return true;
    }
    if (
      frame.blob.type !== "image/jpeg" ||
      frame.blob.size < 4 ||
      frame.blob.size > request.maxBytes ||
      frame.width < 1 ||
      frame.width > request.maxWidth ||
      frame.height < 1 ||
      frame.height > 8_192
    ) {
      sendError(send, request.id, "FRAME_INVALID");
      return true;
    }
    const data = await blobBase64(frame.blob);
    send(
      JSON.stringify({
        schemaVersion: 1,
        type: "decoded-frame",
        id: request.id,
        mimeType: "image/jpeg",
        width: frame.width,
        height: frame.height,
        data,
      }),
    );
  } catch {
    sendError(send, request.id, "FRAME_CAPTURE_FAILED");
  }
  return true;
}
