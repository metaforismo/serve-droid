import { describe, expect, it, vi } from "vitest";
import {
  handleDecodedFrameRequest,
  parseDecodedFrameRequest,
  type DecodedFrameRequest,
} from "../src/decoded-frame.js";

const request: DecodedFrameRequest = {
  schemaVersion: 1,
  type: "capture-decoded-frame",
  id: "0123456789abcdef0123456789abcdef",
  maxWidth: 1_080,
  quality: 75,
  maxBytes: 1_500_000,
};

function jpegBlob(): Blob {
  return new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
}

describe("decoded frame request parsing", () => {
  it("accepts only the bounded versioned request", () => {
    expect(parseDecodedFrameRequest(request)).toEqual(request);
    expect(parseDecodedFrameRequest({ type: "other" })).toBeNull();
    expect(() => parseDecodedFrameRequest({ ...request, maxBytes: 2_000_000 })).toThrow(
      "Decoded frame request is malformed",
    );
  });
});

describe("decoded frame responder", () => {
  it("ignores unrelated or invalid JSON messages", async () => {
    const send = vi.fn();
    await expect(handleDecodedFrameRequest("not-json", send)).resolves.toBe(false);
    await expect(
      handleDecodedFrameRequest(JSON.stringify({ type: "audio-state" }), send),
    ).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns a bounded base64 JPEG from the decoded canvas capture", async () => {
    const send = vi.fn();
    const capture = vi.fn(async () => ({ blob: jpegBlob(), width: 3, height: 2 }));

    await expect(
      handleDecodedFrameRequest(JSON.stringify(request), send, capture),
    ).resolves.toBe(true);

    expect(capture).toHaveBeenCalledWith({
      maxWidth: 1_080,
      quality: 75,
      maxBytes: 1_500_000,
    });
    expect(JSON.parse(send.mock.calls[0]![0] as string)).toEqual({
      schemaVersion: 1,
      type: "decoded-frame",
      id: request.id,
      mimeType: "image/jpeg",
      width: 3,
      height: 2,
      data: "/9j/2Q==",
    });
  });

  it("reports a frame that is not ready without throwing", async () => {
    const send = vi.fn();
    await handleDecodedFrameRequest(JSON.stringify(request), send, async () => null);
    expect(JSON.parse(send.mock.calls[0]![0] as string)).toMatchObject({
      type: "decoded-frame-error",
      id: request.id,
      code: "FRAME_NOT_READY",
    });
  });

  it("rejects malformed and oversized captures before sending image bytes", async () => {
    const malformed = vi.fn();
    await handleDecodedFrameRequest(
      JSON.stringify({ ...request, quality: 100 }),
      malformed,
      async () => ({ blob: jpegBlob(), width: 3, height: 2 }),
    );
    expect(JSON.parse(malformed.mock.calls[0]![0] as string)).toMatchObject({
      type: "decoded-frame-error",
      code: "INVALID_REQUEST",
    });

    const oversized = vi.fn();
    await handleDecodedFrameRequest(JSON.stringify(request), oversized, async () => ({
      blob: new Blob([new Uint8Array(request.maxBytes + 1)], { type: "image/jpeg" }),
      width: 3,
      height: 2,
    }));
    expect(JSON.parse(oversized.mock.calls[0]![0] as string)).toMatchObject({
      type: "decoded-frame-error",
      code: "FRAME_INVALID",
    });
  });

  it("converts capture exceptions into a bounded protocol error", async () => {
    const send = vi.fn();
    await handleDecodedFrameRequest(JSON.stringify(request), send, async () => {
      throw new Error("canvas is tainted");
    });
    expect(JSON.parse(send.mock.calls[0]![0] as string)).toMatchObject({
      type: "decoded-frame-error",
      code: "FRAME_CAPTURE_FAILED",
    });
    expect(send.mock.calls[0]![0]).not.toContain("canvas is tainted");
  });
});
