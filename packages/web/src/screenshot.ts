export type ScreenshotSource = "stream" | "device";

export interface CapturedScreenshot {
  blob: Blob;
  source: ScreenshotSource;
  width: number | null;
  height: number | null;
  capturedAt: string;
}

export interface DecodedFrameCaptureOptions {
  maxWidth: number;
  quality: number;
  maxBytes: number;
}

export interface DecodedFrameCapture {
  blob: Blob;
  width: number;
  height: number;
}

export interface DecodedFrameCaptureDependencies {
  createCanvas?: () => HTMLCanvasElement;
}

interface CaptureTarget {
  canvas: HTMLCanvasElement;
  frameReady: boolean;
}

const MAX_JPEG_ATTEMPTS = 6;
const MIN_JPEG_QUALITY = 0.35;
let captureTarget: CaptureTarget | null = null;

export function registerScreenshotCanvas(canvas: HTMLCanvasElement): () => void {
  const target: CaptureTarget = { canvas, frameReady: false };
  captureTarget = target;
  return () => {
    if (captureTarget === target) captureTarget = null;
  };
}

export function markScreenshotFrame(canvas: HTMLCanvasElement): void {
  if (captureTarget?.canvas === canvas) captureTarget.frameReady = true;
}

function canvasBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error(`The decoded frame could not be encoded as ${mimeType}.`));
        },
        mimeType,
        quality,
      );
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return canvasBlob(canvas, "image/png");
}

function validateDecodedFrameOptions(options: DecodedFrameCaptureOptions): void {
  if (!Number.isInteger(options.maxWidth) || options.maxWidth < 1 || options.maxWidth > 2_048) {
    throw new Error("Decoded frame maxWidth is outside the supported range.");
  }
  if (!Number.isInteger(options.quality) || options.quality < 25 || options.quality > 95) {
    throw new Error("Decoded frame quality is outside the supported range.");
  }
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 1_500_000) {
    throw new Error("Decoded frame maxBytes is outside the supported range.");
  }
}

export async function captureDecodedFrame(
  options: DecodedFrameCaptureOptions,
  dependencies: DecodedFrameCaptureDependencies = {},
): Promise<DecodedFrameCapture | null> {
  validateDecodedFrameOptions(options);
  const target = captureTarget;
  if (!target?.frameReady || target.canvas.width < 1 || target.canvas.height < 1) return null;

  const source = target.canvas;
  const initialWidth = Math.min(source.width, options.maxWidth);
  const aspectRatio = source.height / source.width;
  const output = (dependencies.createCanvas ?? (() => document.createElement("canvas")))();
  let width = initialWidth;
  let quality = options.quality / 100;
  let lastError: Error = new Error("The decoded frame could not be encoded as image/jpeg.");

  for (let attempt = 0; attempt < MAX_JPEG_ATTEMPTS; attempt += 1) {
    const height = Math.max(1, Math.round(width * aspectRatio));
    output.width = width;
    output.height = height;
    const context = output.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D is unavailable for decoded frame capture.");
    context.drawImage(source, 0, 0, width, height);

    try {
      const blob = await canvasBlob(output, "image/jpeg", quality);
      if (blob.type === "image/jpeg" && blob.size >= 4 && blob.size <= options.maxBytes) {
        return { blob, width, height };
      }
      lastError = new Error("The decoded JPEG exceeds the requested byte limit.");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (quality > MIN_JPEG_QUALITY) {
      quality = Math.max(MIN_JPEG_QUALITY, Math.round((quality - 0.12) * 100) / 100);
    } else if (width > 1) {
      width = Math.max(1, Math.floor(width * 0.75));
      quality = Math.min(options.quality / 100, 0.65);
    }
  }

  throw lastError;
}

export async function captureScreenshot(
  fallback: () => Promise<Blob>,
  now: () => Date = () => new Date(),
): Promise<CapturedScreenshot> {
  const target = captureTarget;
  const capturedAt = now().toISOString();
  if (target?.frameReady && target.canvas.width > 0 && target.canvas.height > 0) {
    try {
      return {
        blob: await canvasPng(target.canvas),
        source: "stream",
        width: target.canvas.width,
        height: target.canvas.height,
        capturedAt,
      };
    } catch {
      // A browser may refuse canvas export even after rendering. The authenticated
      // device endpoint remains the bounded fallback instead of failing the action.
    }
  }

  return {
    blob: await fallback(),
    source: "device",
    width: null,
    height: null,
    capturedAt,
  };
}

export function screenshotFileName(
  capture: Pick<CapturedScreenshot, "blob" | "capturedAt">,
): string {
  const extension = capture.blob.type === "image/jpeg" ? "jpg" : "png";
  const timestamp = capture.capturedAt.replace(/[:.]/gu, "-");
  return `serve-droid-screenshot-${timestamp}.${extension}`;
}

export function canCopyScreenshot(mimeType = "image/png"): boolean {
  return (
    window.isSecureContext &&
    typeof ClipboardItem !== "undefined" &&
    (typeof ClipboardItem.supports !== "function" || ClipboardItem.supports(mimeType)) &&
    typeof navigator.clipboard?.write === "function"
  );
}

export async function copyScreenshot(blob: Blob): Promise<void> {
  const mimeType = blob.type || "image/png";
  if (!canCopyScreenshot(mimeType))
    throw new Error("Image clipboard access is unavailable in this browser.");
  await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
}
