import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureScreenshot,
  markScreenshotFrame,
  registerScreenshotCanvas,
  screenshotFileName,
} from "../src/screenshot.js";

function fakeCanvas(blob: Blob | null, width = 1080, height = 2400): HTMLCanvasElement {
  return {
    width,
    height,
    toBlob(callback: BlobCallback) {
      callback(blob);
    },
  } as unknown as HTMLCanvasElement;
}

let release: () => void = () => undefined;

afterEach(() => {
  release();
  release = () => undefined;
});

describe("browser screenshot capture", () => {
  it("captures the decoded canvas before calling the device fallback", async () => {
    const canvas = fakeCanvas(new Blob(["stream"], { type: "image/png" }));
    release = registerScreenshotCanvas(canvas);
    markScreenshotFrame(canvas);
    const fallback = vi.fn(async () => new Blob(["device"], { type: "image/jpeg" }));

    const result = await captureScreenshot(fallback, () => new Date("2026-08-16T21:30:00.000Z"));

    expect(result.source).toBe("stream");
    expect(result.width).toBe(1080);
    expect(result.height).toBe(2400);
    expect(result.blob.type).toBe("image/png");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("uses the authenticated device fallback before the first decoded frame", async () => {
    release = registerScreenshotCanvas(fakeCanvas(new Blob(["stream"], { type: "image/png" })));
    const fallback = vi.fn(async () => new Blob(["device"], { type: "image/jpeg" }));

    const result = await captureScreenshot(fallback);

    expect(result.source).toBe("device");
    expect(result.width).toBeNull();
    expect(result.height).toBeNull();
    expect(result.blob.type).toBe("image/jpeg");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("falls back when the browser refuses to encode the live canvas", async () => {
    const canvas = fakeCanvas(null);
    release = registerScreenshotCanvas(canvas);
    markScreenshotFrame(canvas);
    const fallback = vi.fn(async () => new Blob(["device"], { type: "image/jpeg" }));

    const result = await captureScreenshot(fallback);

    expect(result.source).toBe("device");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("creates chronological filesystem-safe filenames", () => {
    expect(
      screenshotFileName({
        blob: new Blob(["png"], { type: "image/png" }),
        capturedAt: "2026-08-16T21:30:00.123Z",
      }),
    ).toBe("serve-droid-screenshot-2026-08-16T21-30-00-123Z.png");
  });
});
