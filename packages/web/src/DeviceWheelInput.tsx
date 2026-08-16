import { useEffect, useState } from "react";
import { action, hasAuthenticationToken } from "./api.js";
import { wheelDeltasToSwipe, wheelDeltaToPixels } from "./wheel.js";
import "./device-wheel-input.css";

type NoticeKind = "sending" | "sent" | "error";

interface WheelNotice {
  kind: NoticeKind;
  message: string;
}

interface PendingWheel {
  deltaX: number;
  deltaY: number;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
}

const FLUSH_DELAY_MS = 52;
const SENT_NOTICE_MS = 1_200;
const ERROR_NOTICE_MS = 3_500;
const DEVICE_CANVAS_LABEL = "Live Android device.";
const loopbackDemoMode =
  new URLSearchParams(location.search).has("demo") &&
  ["127.0.0.1", "localhost", "::1"].includes(location.hostname);

function bounded(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

function deviceCanvas(target: EventTarget | null): HTMLCanvasElement | null {
  if (!(target instanceof HTMLCanvasElement)) return null;
  return target.getAttribute("aria-label")?.startsWith(DEVICE_CANVAS_LABEL) ? target : null;
}

export function DeviceWheelInput() {
  const [notice, setNotice] = useState<WheelNotice | null>(null);
  const visible = hasAuthenticationToken || loopbackDemoMode;

  useEffect(() => {
    if (!visible) return;

    let disposed = false;
    let pointerActive = false;
    let inFlight = false;
    let pending: PendingWheel | null = null;
    let flushTimer = 0;
    let noticeTimer = 0;

    function showNotice(next: WheelNotice, timeoutMs = 0): void {
      window.clearTimeout(noticeTimer);
      if (disposed) return;
      setNotice(next);
      if (timeoutMs > 0) {
        noticeTimer = window.setTimeout(() => {
          if (!disposed) setNotice(null);
        }, timeoutMs);
      }
    }

    function scheduleFlush(): void {
      if (flushTimer || disposed) return;
      flushTimer = window.setTimeout(() => {
        flushTimer = 0;
        void flushPending();
      }, FLUSH_DELAY_MS);
    }

    async function flushPending(): Promise<void> {
      if (disposed || inFlight || !pending) return;
      const next = pending;
      pending = null;
      const swipe = wheelDeltasToSwipe(next);
      if (!swipe) {
        if (pending) scheduleFlush();
        return;
      }

      inFlight = true;
      showNotice({ kind: "sending", message: "Scrolling Android device…" });
      try {
        await action({ type: "swipe", ...swipe });
        showNotice({ kind: "sent", message: "Scroll sent" }, SENT_NOTICE_MS);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        showNotice({ kind: "error", message: `Scroll failed: ${message}` }, ERROR_NOTICE_MS);
      } finally {
        inFlight = false;
        if (pending) scheduleFlush();
      }
    }

    const onWheel = (event: WheelEvent) => {
      const canvas = deviceCanvas(event.target);
      if (!canvas || pointerActive || event.buttons !== 0 || event.ctrlKey || event.metaKey) return;
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;

      const deltaX = wheelDeltaToPixels(event.deltaX, event.deltaMode, bounds.width);
      const deltaY = wheelDeltaToPixels(event.deltaY, event.deltaMode, bounds.height);
      if (deltaX === 0 && deltaY === 0) return;

      event.preventDefault();
      event.stopPropagation();
      const maximumX = bounds.width * 0.45;
      const maximumY = bounds.height * 0.45;
      pending = {
        deltaX: bounded((pending?.deltaX ?? 0) + deltaX, maximumX),
        deltaY: bounded((pending?.deltaY ?? 0) + deltaY, maximumY),
        width: bounds.width,
        height: bounds.height,
        anchorX: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
        anchorY: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
      };
      scheduleFlush();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (deviceCanvas(event.target)) pointerActive = true;
    };
    const releasePointer = () => {
      pointerActive = false;
    };

    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", releasePointer, true);
    window.addEventListener("pointercancel", releasePointer, true);
    window.addEventListener("blur", releasePointer);

    return () => {
      disposed = true;
      pending = null;
      window.clearTimeout(flushTimer);
      window.clearTimeout(noticeTimer);
      document.removeEventListener("wheel", onWheel, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", releasePointer, true);
      window.removeEventListener("pointercancel", releasePointer, true);
      window.removeEventListener("blur", releasePointer);
    };
  }, [visible]);

  if (!visible || !notice) return null;

  return (
    <div
      className={`device-wheel-feedback ${notice.kind}`}
      role={notice.kind === "error" ? "alert" : "status"}
      aria-live={notice.kind === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      data-testid="device-wheel-feedback"
    >
      <span className="device-wheel-glyph" aria-hidden="true">
        ↕
      </span>
      <span>{notice.message}</span>
    </div>
  );
}
