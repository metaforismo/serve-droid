export type ScreenshotSource = "stream" | "device";

export interface CapturedScreenshot {
  blob: Blob;
  source: ScreenshotSource;
  width: number | null;
  height: number | null;
  capturedAt: string;
}

interface CaptureTarget {
  canvas: HTMLCanvasElement;
  frameReady: boolean;
}

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

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The decoded frame could not be encoded as PNG."));
      }, "image/png");
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
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
