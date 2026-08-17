import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureDecodedFrame,
  markScreenshotFrame,
  registerScreenshotCanvas,
} from "../src/screenshot.js";

function sourceCanvas(width = 2_000, height = 1_000): HTMLCanvasElement {
  return { width, height } as HTMLCanvasElement;
}

function outputCanvas(
  encode: (quality: number) => Blob | null,
): { canvas: HTMLCanvasElement; drawImage: ReturnType<typeof vi.fn>; qualities: number[] } {
  const drawImage = vi.fn();
  const qualities: number[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toBlob(callback: BlobCallback, _type?: string, quality?: number) {
      qualities.push(quality ?? 0);
      callback(encode(quality ?? 0));
    },
  } as unknown as HTMLCanvasElement;
  return { canvas, drawImage, qualities };
}

let release: () => void = () => undefined;
afterEach(() => {
  release();
  release = () => undefined;
});

describe("decoded frame JPEG capture", () => {
  it("returns null before the first decoded frame", async () => {
    release = registerScreenshotCanvas(sourceCanvas());
    await expect(
      captureDecodedFrame(
        { maxWidth: 1_080, quality: 75, maxBytes: 1_500_000 },
        { createCanvas: () => outputCanvas(() => new Blob()).canvas },
      ),
    ).resolves.toBeNull();
  });

  it("snapshots and scales the current decoded canvas", async () => {
    const source = sourceCanvas();
    release = registerScreenshotCanvas(source);
    markScreenshotFrame(source);
    const output = outputCanvas(() => new Blob(["jpeg"], { type: "image/jpeg" }));

    const frame = await captureDecodedFrame(
      { maxWidth: 1_000, quality: 75, maxBytes: 1_500_000 },
      { createCanvas: () => output.canvas },
    );

    expect(frame).toMatchObject({ width: 1_000, height: 500 });
    expect(frame?.blob.type).toBe("image/jpeg");
    expect(output.canvas.width).toBe(1_000);
    expect(output.canvas.height).toBe(500);
    expect(output.drawImage).toHaveBeenCalledWith(source, 0, 0, 1_000, 500);
    expect(output.qualities).toEqual([0.75]);
  });

  it("reduces JPEG quality within a fixed attempt budget when the first encoding is too large", async () => {
    const source = sourceCanvas(1_080, 1_920);
    release = registerScreenshotCanvas(source);
    markScreenshotFrame(source);
    let attempts = 0;
    const output = outputCanvas(() => {
      attempts += 1;
      return new Blob([new Uint8Array(attempts === 1 ? 101 : 80)], { type: "image/jpeg" });
    });

    const frame = await captureDecodedFrame(
      { maxWidth: 1_080, quality: 75, maxBytes: 100 },
      { createCanvas: () => output.canvas },
    );

    expect(frame?.blob.size).toBe(80);
    expect(output.qualities).toEqual([0.75, 0.63]);
  });

  it("fails after bounded retries when the browser cannot produce a valid JPEG", async () => {
    const source = sourceCanvas(320, 640);
    release = registerScreenshotCanvas(source);
    markScreenshotFrame(source);
    const output = outputCanvas(() => null);

    await expect(
      captureDecodedFrame(
        { maxWidth: 320, quality: 75, maxBytes: 100 },
        { createCanvas: () => output.canvas },
      ),
    ).rejects.toThrow("decoded frame could not be encoded");
    expect(output.qualities.length).toBeLessThanOrEqual(6);
  });
});
