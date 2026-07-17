import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  action,
  api,
  authenticatedWebSocket,
  screenshot,
  upload,
  type LogEntry,
  type Observation,
  type UiElement,
} from "./api.js";
import { createH264CanvasPlayer, type CanvasPlayer } from "./video.js";

type Panel = "logs" | "tree";
const demoMode = new URLSearchParams(location.search).has("demo");

function label(element: UiElement): string {
  return element.text || element.contentDescription || element.resourceId || element.className;
}

export function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selected, setSelected] = useState<UiElement | null>(null);
  const [panel, setPanel] = useState<Panel>("logs");
  const [status, setStatus] = useState("Connecting");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [frames, setFrames] = useState(0);
  const [previewUrl, setPreviewUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [decoder, setDecoder] = useState<"WebCodecs" | "TinyH264" | "">("");

  const refresh = useCallback(async () => {
    try {
      const result = await api<Observation>(
        `/api/v1/observe?logsSince=${observation?.nextLogCursor ?? "0"}`,
      );
      setObservation(result);
      setLogs((previous) => [...previous, ...result.logs].slice(-1000));
      setStatus(demoMode ? "Demo preview" : "Connected");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus("Disconnected");
    }
  }, [observation?.nextLogCursor]);

  useEffect(() => {
    if (!observation || frames > 0) return;
    let cancelled = false;
    void screenshot(observation.screenshot.url)
      .then((blob) => {
        if (cancelled) return;
        const nextUrl = URL.createObjectURL(blob);
        setPreviewUrl(nextUrl);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    return () => {
      cancelled = true;
    };
  }, [frames, observation]);

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (demoMode) return;
    if (!canvas.current) return;
    let player: CanvasPlayer | undefined;
    let socket: WebSocket | undefined;
    let cancelled = false;
    void createH264CanvasPlayer({
      canvas: canvas.current,
      onFrame: () => setFrames((value) => value + 1),
      onError: setError,
    })
      .then((created) => {
        if (cancelled) {
          created.close();
          return;
        }
        player = created;
        const backend = created.backend === "webcodecs" ? "WebCodecs" : "TinyH264";
        setDecoder(backend);
        socket = authenticatedWebSocket("/api/v1/video");
        socket.binaryType = "arraybuffer";
        socket.onopen = () => setStatus(`Streaming · ${backend}`);
        socket.onmessage = (event) => player?.push(event.data as ArrayBuffer);
        socket.onclose = (event) =>
          event.code !== 1000 && setError(event.reason || "Video stream closed.");
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    return () => {
      cancelled = true;
      socket?.close();
      player?.close();
    };
  }, []);

  const filteredElements = useMemo(() => {
    const needle = query.toLocaleLowerCase();
    return (observation?.elements ?? []).filter((element) =>
      label(element).toLocaleLowerCase().includes(needle),
    );
  }, [observation?.elements, query]);

  const tapCanvas = async (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    await action({
      type: "tap",
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    });
    await refresh();
  };

  const tapElement = async (element: UiElement) => {
    if (!element.enabled) return;
    setSelected(element);
    await action({
      type: "tap",
      x: (element.bounds.left + element.bounds.right) / 2,
      y: (element.bounds.top + element.bounds.bottom) / 2,
    });
    await refresh();
  };

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    setUploading(true);
    try {
      await upload(file);
      setStatus(file.name.endsWith(".apk") ? "APK installed" : "File pushed");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setUploading(false);
    }
  };

  return (
    <main
      className="shell"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => void onDrop(event)}
    >
      <header className="topbar">
        <div className="brand">
          <span className="mark">sd</span>
          <strong>serve-droid</strong>
          <span className="version">v0.1</span>
        </div>
        <div className="device-meta">
          <span className={`status ${error ? "bad" : ""}`}>
            <i />
            {status}
          </span>
          {demoMode && <span className="demo-badge">Demo data</span>}
          <span>
            {observation?.device.model ?? observation?.device.serial ?? "Waiting for device"}
          </span>
          <span>{observation ? `API ${observation.device.apiLevel}` : ""}</span>
          <span>
            {observation ? `${observation.display.width}×${observation.display.height}` : ""}
          </span>
          <span>{frames ? `${frames} frames` : ""}</span>
          <span>{decoder}</span>
        </div>
      </header>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {uploading && (
        <div className="drop-status" role="status">
          Transferring file…
        </div>
      )}

      <section className="workspace">
        <aside className="toolbar" aria-label="Device controls">
          <button title="Back" onClick={() => void action({ type: "key", key: "back" })}>
            ←
          </button>
          <button title="Home" onClick={() => void action({ type: "key", key: "home" })}>
            ⌂
          </button>
          <button title="Recents" onClick={() => void action({ type: "key", key: "recents" })}>
            ▣
          </button>
          <span className="rule" />
          <button
            title="Rotate left"
            onClick={() => void action({ type: "rotate", orientation: "landscape-left" })}
          >
            ↶
          </button>
          <button
            title="Portrait"
            onClick={() => void action({ type: "rotate", orientation: "portrait" })}
          >
            ▯
          </button>
          <button title="Power" onClick={() => void action({ type: "key", key: "power" })}>
            ⏻
          </button>
        </aside>

        <div className="stage">
          <div
            className={`phone ${observation?.display.orientation !== "portrait" ? "landscape" : ""}`}
          >
            {previewUrl && frames === 0 && (
              <img src={previewUrl} alt="Current Android device screenshot" />
            )}
            <canvas
              ref={canvas}
              aria-label="Live Android device. Click to tap."
              onPointerUp={(event) => void tapCanvas(event)}
            />
            {selected && (
              <div
                className="element-overlay"
                style={{
                  left: `${selected.bounds.left * 100}%`,
                  top: `${selected.bounds.top * 100}%`,
                  width: `${(selected.bounds.right - selected.bounds.left) * 100}%`,
                  height: `${(selected.bounds.bottom - selected.bounds.top) * 100}%`,
                }}
              />
            )}
          </div>
          <p className="hint">Drop an APK to install · Drop any other file to push to Downloads</p>
        </div>

        <aside className="inspector">
          <div className="tabs" role="tablist">
            <button className={panel === "logs" ? "active" : ""} onClick={() => setPanel("logs")}>
              Logcat
            </button>
            <button className={panel === "tree" ? "active" : ""} onClick={() => setPanel("tree")}>
              UI tree <em>{observation?.elements.length ?? 0}</em>
            </button>
          </div>
          {panel === "logs" ? (
            <div className="logs" aria-live="polite">
              {logs.length === 0 && <p className="empty">No app logs yet.</p>}
              {logs.map((entry) => (
                <div className={`log p-${entry.priority}`} key={entry.cursor}>
                  <time>{entry.timestamp.slice(11, 23)}</time>
                  <b>
                    {entry.priority}/{entry.tag}
                  </b>
                  <span>{entry.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="tree">
              <input
                aria-label="Filter UI elements"
                placeholder="Filter text, label, or resource ID"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="nodes">
                {filteredElements.map((element) => (
                  <button
                    key={element.id}
                    className={selected?.id === element.id ? "selected" : ""}
                    disabled={!element.enabled}
                    onMouseEnter={() => setSelected(element)}
                    onFocus={() => setSelected(element)}
                    onClick={() => void tapElement(element)}
                  >
                    <strong>{label(element) || "Unnamed element"}</strong>
                    <span>
                      {element.className.split(".").at(-1)} · {element.resourceId || "no id"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>
      </section>

      <footer>
        <span>{observation?.foregroundApp.packageName ?? "No foreground app"}</span>
        <span>{observation?.foregroundApp.activity}</span>
        <button onClick={() => void refresh()}>Refresh observation</button>
      </footer>
    </main>
  );
}
