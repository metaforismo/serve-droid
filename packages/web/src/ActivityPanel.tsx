import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

type ActivityDetail = string | number | boolean | null;

interface ActivityEvent {
  schemaVersion: 1;
  cursor: string;
  timestamp: string;
  type: string;
  details: Record<string, ActivityDetail>;
}

interface ActivityPage {
  schemaVersion: 1;
  events: ActivityEvent[];
  nextCursor: string;
  truncated: boolean;
}

const CLIENT_ACTIVITY_LIMIT = 256;
const POLL_INTERVAL_MS = 2_000;

function label(type: string): string {
  switch (type) {
    case "session-start":
      return "Session started";
    case "session-stop":
      return "Session stopped";
    case "recording-start":
      return "Recording started";
    case "recording-stop":
      return "Recording stopped";
    case "video-error":
      return "Video transport error";
    case "video-restart":
      return "Video transport restarted";
    case "display-size":
      return "Display changed";
    case "screenshot":
      return "Screenshot captured";
    case "action":
      return "Device action";
    case "app":
      return "App action";
    case "permission":
      return "Permission changed";
    case "file":
      return "File transfer";
    default:
      return "Session event";
  }
}

function summary(event: ActivityEvent): string {
  const details = event.details;
  if (event.type === "action" && typeof details.action === "string") {
    return String(details.action);
  }
  if (event.type === "app" && typeof details.operation === "string") {
    return [details.operation, details.packageName].filter(Boolean).join(" · ");
  }
  if (event.type === "permission" && typeof details.operation === "string") {
    return [details.operation, details.permission].filter(Boolean).join(" · ");
  }
  if (event.type === "file" && typeof details.operation === "string") {
    return String(details.operation);
  }
  if (event.type === "screenshot") {
    const dimensions =
      typeof details.width === "number" && typeof details.height === "number"
        ? `${details.width}×${details.height}`
        : "";
    return [details.source, dimensions].filter(Boolean).join(" · ");
  }
  if (event.type === "display-size") {
    return typeof details.width === "number" && typeof details.height === "number"
      ? `${details.width}×${details.height}`
      : "";
  }
  if (event.type === "video-restart") {
    return typeof details.attempt === "number"
      ? `attempt ${details.attempt}${typeof details.maxAttempts === "number" ? ` of ${details.maxAttempts}` : ""}`
      : "";
  }
  if (event.type === "video-error" && typeof details.kind === "string") {
    return details.kind;
  }
  if (event.type === "recording-start" || event.type === "recording-stop") {
    return typeof details.trigger === "string" ? details.trigger : "";
  }
  if (event.type === "session-start") {
    return [
      details.serial,
      details.width && details.height ? `${details.width}×${details.height}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return "";
}

function mergeActivity(previous: ActivityEvent[], page: ActivityPage): ActivityEvent[] {
  if (page.truncated) return page.events.slice(-CLIENT_ACTIVITY_LIMIT);
  const byCursor = new Map(previous.map((event) => [event.cursor, event]));
  for (const event of page.events) byCursor.set(event.cursor, event);
  return [...byCursor.values()]
    .sort((left, right) => Number(left.cursor) - Number(right.cursor))
    .slice(-CLIENT_ACTIVITY_LIMIT);
}

export function ActivityPanel({ active }: { active: boolean }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState("Activity ready");
  const cursor = useRef("0");

  const refresh = useCallback(async () => {
    try {
      const page = await api<ActivityPage>(
        `/api/v1/activity?since=${encodeURIComponent(cursor.current)}`,
      );
      cursor.current = page.nextCursor;
      setEvents((previous) => mergeActivity(previous, page));
      setTruncated(page.truncated);
      setStatus("Live");
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : "Activity unavailable");
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  return (
    <section className="activity-panel" aria-label="Session activity">
      <div className="activity-summary" aria-live="polite">
        <span>
          {events.length} retained event{events.length === 1 ? "" : "s"}
        </span>
        <span className={status === "Live" ? "live" : "attention"}>{status}</span>
      </div>
      {truncated && (
        <p className="activity-resync" role="status">
          Older activity expired from the bounded server window. Showing the retained history.
        </p>
      )}
      <div className="activity-list">
        {events.length === 0 && <p className="activity-empty">No session activity yet.</p>}
        {events.map((event) => {
          const detail = summary(event);
          return (
            <article className={`activity-event activity-${event.type}`} key={event.cursor}>
              <time dateTime={event.timestamp}>{event.timestamp.slice(11, 23)}</time>
              <div>
                <strong>{label(event.type)}</strong>
                {detail && <span>{detail}</span>}
              </div>
            </article>
          );
        })}
      </div>
      <p className="activity-privacy">Privacy-filtered · in-memory · bounded to 256 events</p>
    </section>
  );
}
