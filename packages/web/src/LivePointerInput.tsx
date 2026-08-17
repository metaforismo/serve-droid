import { useEffect, useState } from "react";
import { action, authenticatedWebSocket, hasAuthenticationToken } from "./api.js";
import {
  PointerStreamClient,
  type PointerPoint,
  type PointerStreamError,
} from "./pointer-stream.js";
import "./device-wheel-input.css";

type NoticeKind = "sending" | "sent" | "error";

interface PointerNotice {
  kind: NoticeKind;
  message: string;
}

interface ActivePointer {
  pointerId: number;
  pointerType: string;
  canvas: HTMLCanvasElement;
  startedAt: number;
  start: PointerPoint;
  latest: PointerPoint;
  dragging: boolean;
  mode: "pending" | "stream" | "fallback" | "failed";
  begin: Promise<boolean>;
}

interface ClientPosition {
  clientX: number;
  clientY: number;
}

const DEVICE_CANVAS_LABEL = "Live Android device.";
const SENT_NOTICE_MS = 1_200;
const ERROR_NOTICE_MS = 3_500;
const demoMode = new URLSearchParams(location.search).has("demo");

function deviceCanvas(target: EventTarget | null): HTMLCanvasElement | null {
  if (!(target instanceof HTMLCanvasElement)) return null;
  return target.getAttribute("aria-label")?.startsWith(DEVICE_CANVAS_LABEL) ? target : null;
}

function pointOnCanvas(canvas: HTMLCanvasElement, position: ClientPosition): PointerPoint | null {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return {
    x: Math.min(1, Math.max(0, (position.clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (position.clientY - bounds.top) / bounds.height)),
  };
}

function consume(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

export function LivePointerInput() {
  const [notice, setNotice] = useState<PointerNotice | null>(null);

  useEffect(() => {
    if (!hasAuthenticationToken || demoMode) return;

    let disposed = false;
    let active: ActivePointer | null = null;
    let indicator: HTMLSpanElement | null = null;
    let noticeTimer = 0;

    function showNotice(next: PointerNotice, timeoutMs = 0): void {
      window.clearTimeout(noticeTimer);
      if (disposed) return;
      setNotice(next);
      if (timeoutMs > 0) {
        noticeTimer = window.setTimeout(() => {
          if (!disposed) setNotice(null);
        }, timeoutMs);
      }
    }

    function errorNotice(error: unknown): void {
      const message = error instanceof Error ? error.message : String(error);
      showNotice({ kind: "error", message: `Live input failed: ${message}` }, ERROR_NOTICE_MS);
    }

    const client = new PointerStreamClient({
      createSocket: () => authenticatedWebSocket("/api/v1/control"),
      onError: (error: PointerStreamError) => {
        if (active) active.mode = "failed";
        errorNotice(error);
      },
    });
    client.start();

    function removeIndicator(): void {
      indicator?.remove();
      indicator = null;
    }

    function updateIndicator(pointer: ActivePointer): void {
      if (!indicator?.isConnected) {
        indicator = document.createElement("span");
        indicator.className = "touch-indicator live-pointer-indicator";
        indicator.setAttribute("aria-hidden", "true");
        pointer.canvas.parentElement?.append(indicator);
      }
      indicator.classList.toggle("dragging", pointer.dragging);
      indicator.style.left = `${pointer.latest.x * 100}%`;
      indicator.style.top = `${pointer.latest.y * 100}%`;
    }

    function releaseCapture(pointer: ActivePointer): void {
      try {
        if (pointer.canvas.hasPointerCapture(pointer.pointerId)) {
          pointer.canvas.releasePointerCapture(pointer.pointerId);
        }
      } catch {
        // The browser may already have released capture during cancellation.
      }
    }

    async function sendFallback(pointer: ActivePointer, end: PointerPoint): Promise<void> {
      const bounds = pointer.canvas.getBoundingClientRect();
      const distance = Math.hypot(
        (end.x - pointer.start.x) * bounds.width,
        (end.y - pointer.start.y) * bounds.height,
      );
      if (distance < 10) {
        await action({ type: "tap", x: end.x, y: end.y });
        showNotice({ kind: "sent", message: "Tap sent through bounded fallback" }, SENT_NOTICE_MS);
        return;
      }
      const durationMs = Math.min(
        3_000,
        Math.max(50, Math.round(performance.now() - pointer.startedAt)),
      );
      await action({
        type: "swipe",
        x1: pointer.start.x,
        y1: pointer.start.y,
        x2: end.x,
        y2: end.y,
        durationMs,
      });
      showNotice({ kind: "sent", message: "Swipe sent through bounded fallback" }, SENT_NOTICE_MS);
    }

    function finishPointer(pointer: ActivePointer, point: PointerPoint): void {
      if (active !== pointer) return;
      active = null;
      releaseCapture(pointer);
      removeIndicator();

      void (async () => {
        try {
          const streamed = await pointer.begin;
          if (pointer.mode === "failed") return;
          if (streamed) {
            await client.end(point);
            showNotice(
              {
                kind: "sent",
                message: pointer.dragging ? "Live drag completed" : "Live tap completed",
              },
              SENT_NOTICE_MS,
            );
          } else {
            await sendFallback(pointer, point);
          }
        } catch (error) {
          errorNotice(error);
        }
      })();
    }

    const onPointerDown = (event: PointerEvent) => {
      const canvas = deviceCanvas(event.target);
      if (
        !canvas ||
        active ||
        !client.ready ||
        !event.isPrimary ||
        (event.pointerType === "mouse" && event.button !== 0)
      ) {
        return;
      }
      const point = pointOnCanvas(canvas, event);
      if (!point) return;

      consume(event);
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is an optimization; document listeners still finish the gesture.
      }

      const pointer: ActivePointer = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        canvas,
        startedAt: performance.now(),
        start: point,
        latest: point,
        dragging: false,
        mode: "pending",
        begin: Promise.resolve(false),
      };
      active = pointer;
      updateIndicator(pointer);
      showNotice({ kind: "sending", message: "Starting live Android touch…" });
      pointer.begin = client.begin(point);
      void pointer.begin
        .then((streamed) => {
          pointer.mode = streamed ? "stream" : "fallback";
          if (active !== pointer) return;
          if (streamed) {
            if (pointer.latest.x !== pointer.start.x || pointer.latest.y !== pointer.start.y) {
              client.move(pointer.latest);
            }
            showNotice({ kind: "sending", message: "Live Android touch active" });
          } else {
            showNotice({ kind: "sending", message: "Using bounded action fallback" });
          }
        })
        .catch((error: unknown) => {
          pointer.mode = "failed";
          errorNotice(error);
        });
    };

    const onPointerMove = (event: PointerEvent) => {
      const pointer = active;
      if (!pointer || pointer.pointerId !== event.pointerId) return;
      const point = pointOnCanvas(pointer.canvas, event);
      if (!point) return;
      consume(event);
      pointer.latest = point;
      const bounds = pointer.canvas.getBoundingClientRect();
      pointer.dragging =
        Math.hypot(
          (point.x - pointer.start.x) * bounds.width,
          (point.y - pointer.start.y) * bounds.height,
        ) >= 10;
      updateIndicator(pointer);
      if (pointer.mode === "stream") client.move(point);
    };

    const onPointerUp = (event: PointerEvent) => {
      const pointer = active;
      if (!pointer || pointer.pointerId !== event.pointerId) return;
      const point = pointOnCanvas(pointer.canvas, event) ?? pointer.latest;
      consume(event);
      finishPointer(pointer, point);
    };

    const onMouseUp = (event: MouseEvent) => {
      const pointer = active;
      if (!pointer || pointer.pointerType !== "mouse" || event.button !== 0) return;
      const point = pointOnCanvas(pointer.canvas, event) ?? pointer.latest;
      consume(event);
      finishPointer(pointer, point);
    };

    const cancelPointer = (event: PointerEvent) => {
      const pointer = active;
      if (!pointer || pointer.pointerId !== event.pointerId) return;
      consume(event);
      active = null;
      releaseCapture(pointer);
      removeIndicator();
      void pointer.begin
        .then((streamed) => (streamed ? client.cancel(pointer.latest) : undefined))
        .then(() => showNotice({ kind: "sent", message: "Live touch cancelled" }, SENT_NOTICE_MS))
        .catch(errorNotice);
    };

    const onBlur = () => {
      const pointer = active;
      if (!pointer) return;
      active = null;
      releaseCapture(pointer);
      removeIndicator();
      void pointer.begin
        .then((streamed) => (streamed ? client.cancel(pointer.latest) : undefined))
        .catch(errorNotice);
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", cancelPointer, true);
    window.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("blur", onBlur);

    return () => {
      disposed = true;
      active = null;
      removeIndicator();
      window.clearTimeout(noticeTimer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", cancelPointer, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      window.removeEventListener("blur", onBlur);
      client.close();
    };
  }, []);

  if (!notice) return null;

  return (
    <div
      className={`device-wheel-feedback ${notice.kind}`}
      role={notice.kind === "error" ? "alert" : "status"}
      aria-live={notice.kind === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      data-testid="live-pointer-feedback"
    >
      <span className="device-wheel-glyph" aria-hidden="true">
        ●
      </span>
      <span>{notice.message}</span>
    </div>
  );
}
