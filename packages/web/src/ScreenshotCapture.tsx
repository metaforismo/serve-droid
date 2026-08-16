import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  Check,
  Copy,
  DownloadSimple,
  SpinnerGap,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { hasAuthenticationToken, screenshot } from "./api.js";
import {
  canCopyScreenshot,
  captureScreenshot,
  copyScreenshot,
  screenshotFileName,
  type CapturedScreenshot,
} from "./screenshot.js";
import "./screenshot-capture.css";

interface ScreenshotNotice extends CapturedScreenshot {
  fileName: string;
  url: string;
}

type CopyState = "idle" | "copying" | "copied";

const loopbackDemoMode =
  new URLSearchParams(location.search).has("demo") &&
  ["127.0.0.1", "localhost", "::1"].includes(location.hostname);

function sourceLabel(capture: ScreenshotNotice): string {
  if (capture.source === "stream") {
    const dimensions =
      capture.width && capture.height ? ` · ${capture.width} × ${capture.height}` : "";
    return `Decoded live frame${dimensions}`;
  }
  return "Authenticated device fallback";
}

export function ScreenshotCapture() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ScreenshotNotice | null>(null);
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const objectUrl = useRef("");
  const copyTimer = useRef(0);
  const inFlight = useRef(false);
  const visible = hasAuthenticationToken || loopbackDemoMode;

  const clearObjectUrl = useCallback(() => {
    if (!objectUrl.current) return;
    URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = "";
  }, []);

  const dismiss = useCallback(() => {
    clearObjectUrl();
    setNotice(null);
    setError("");
    setCopyState("idle");
  }, [clearObjectUrl]);

  const capture = useCallback(async () => {
    if (!visible || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await captureScreenshot(() => screenshot("/api/v1/screenshot"));
      clearObjectUrl();
      const url = URL.createObjectURL(result.blob);
      objectUrl.current = url;
      setNotice({ ...result, fileName: screenshotFileName(result), url });
      setCopyState("idle");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [clearObjectUrl, visible]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!visible) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLocaleLowerCase() === "s"
      ) {
        event.preventDefault();
        void capture();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [capture, visible]);

  useEffect(
    () => () => {
      clearObjectUrl();
      window.clearTimeout(copyTimer.current);
    },
    [clearObjectUrl],
  );

  if (!visible) return null;

  const download = () => {
    if (!notice) return;
    const link = document.createElement("a");
    link.href = notice.url;
    link.download = notice.fileName;
    link.click();
  };

  const copy = async () => {
    if (!notice || copyState === "copying") return;
    setCopyState("copying");
    try {
      await copyScreenshot(notice.blob);
      setCopyState("copied");
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopyState("idle"), 1_800);
    } catch (reason) {
      setCopyState("idle");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="screenshot-capture" aria-live="polite">
      {notice && (
        <aside className="screenshot-notice" aria-label="Captured screenshot">
          <img src={notice.url} alt="Captured Android screen" />
          <div className="screenshot-notice-body">
            <div className="screenshot-notice-heading">
              <div>
                <strong>Screenshot captured</strong>
                <span>{sourceLabel(notice)}</span>
              </div>
              <button type="button" onClick={dismiss} aria-label="Dismiss screenshot">
                <X />
              </button>
            </div>
            <div className="screenshot-notice-actions">
              <button type="button" onClick={download} aria-label="Download screenshot">
                <DownloadSimple />
                Download
              </button>
              {canCopyScreenshot(notice.blob.type || "image/png") && (
                <button
                  type="button"
                  onClick={() => void copy()}
                  disabled={copyState === "copying"}
                  aria-label="Copy screenshot"
                >
                  {copyState === "copied" ? <Check /> : <Copy />}
                  {copyState === "copied"
                    ? "Copied"
                    : copyState === "copying"
                      ? "Copying…"
                      : "Copy"}
                </button>
              )}
            </div>
          </div>
        </aside>
      )}

      {error && (
        <div className="screenshot-error" role="alert">
          <WarningCircle />
          <span>{error}</span>
          <button type="button" onClick={() => setError("")} aria-label="Dismiss screenshot error">
            <X />
          </button>
        </div>
      )}

      <button
        type="button"
        className="screenshot-trigger"
        onClick={() => void capture()}
        disabled={busy}
        aria-label="Capture screenshot"
        title="Capture screenshot · Ctrl/⌘ + Shift + S"
      >
        {busy ? <SpinnerGap className="screenshot-spinner" /> : <Camera />}
        <span>{busy ? "Capturing…" : "Capture"}</span>
      </button>
    </div>
  );
}
