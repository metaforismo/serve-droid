import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowsClockwise,
  Copy,
  DeviceMobile,
  House,
  MagnifyingGlass,
  Pause,
  Play,
  Power,
  SpeakerHigh,
  SpeakerSlash,
  Stack,
  Trash,
} from "@phosphor-icons/react";
import {
  action,
  api,
  authenticatedWebSocket,
  screenshot,
  upload,
  type LogEntry,
  type Observation,
  type RemoteAccess,
  type UiElement,
} from "./api.js";
import { createH264CanvasPlayer, type CanvasPlayer } from "./video.js";
import { nextAudioReconnectDelay, OpusAudioPlayer } from "./audio.js";

type Panel = "logs" | "tree";
type LogPriority = "all" | "V" | "D" | "I" | "W" | "E" | "F";
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
  const [logQuery, setLogQuery] = useState("");
  const [logPriority, setLogPriority] = useState<LogPriority>("all");
  const [logsPaused, setLogsPaused] = useState(false);
  const [pausedLogs, setPausedLogs] = useState<LogEntry[] | null>(null);
  const [copyStatus, setCopyStatus] = useState("Copy visible logs");
  const [status, setStatus] = useState("Connecting");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [frames, setFrames] = useState(0);
  const [previewUrl, setPreviewUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [decoder, setDecoder] = useState<"WebCodecs" | "TinyH264" | "">("");
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioStatus, setAudioStatus] = useState("Audio muted");
  const [remoteAccess, setRemoteAccess] = useState<RemoteAccess | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [result, remote] = await Promise.all([
        api<Observation>(`/api/v1/observe?logsSince=${observation?.nextLogCursor ?? "0"}`),
        api<RemoteAccess>("/api/v1/remote-access"),
      ]);
      setObservation(result);
      setRemoteAccess(remote);
      setLogs((previous) => {
        const byCursor = new Map(previous.map((entry) => [entry.cursor, entry]));
        for (const entry of result.logs) byCursor.set(entry.cursor, entry);
        return [...byCursor.values()].slice(-1000);
      });
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

  useEffect(() => {
    if (!audioPlaying || demoMode) return;
    let cancelled = false;
    let socket: WebSocket | undefined;
    let reconnectTimer = 0;
    let reconnectDelay = 250;
    let player: OpusAudioPlayer | undefined;

    const connect = () => {
      if (cancelled) return;
      socket = authenticatedWebSocket("/api/v1/audio");
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        reconnectDelay = 250;
        setAudioStatus("Audio connected");
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          const state = JSON.parse(event.data) as {
            available: boolean;
            codec: string | null;
            reason?: string;
          };
          setAudioStatus(
            state.available
              ? `Audio · ${state.codec ?? "ready"}`
              : state.reason || "Audio unavailable",
          );
          return;
        }
        player?.push(event.data as ArrayBuffer);
      };
      socket.onclose = (event) => {
        if (cancelled || event.code === 1000) return;
        setAudioStatus("Audio reconnecting…");
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = nextAudioReconnectDelay(reconnectDelay);
      };
    };

    void OpusAudioPlayer.create(setAudioStatus)
      .then((created) => {
        if (cancelled) return created.close();
        player = created;
        connect();
      })
      .catch((reason: unknown) => {
        setAudioStatus(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      cancelled = true;
      window.clearTimeout(reconnectTimer);
      socket?.close(1000);
      void player?.close();
      setAudioStatus("Audio muted");
    };
  }, [audioPlaying]);

  const filteredElements = useMemo(() => {
    const needle = query.toLocaleLowerCase();
    return (observation?.elements ?? []).filter((element) =>
      label(element).toLocaleLowerCase().includes(needle),
    );
  }, [observation?.elements, query]);

  const displayedLogs = pausedLogs ?? logs;
  const filteredLogs = useMemo(() => {
    const needle = logQuery.trim().toLocaleLowerCase();
    return displayedLogs.filter((entry) => {
      if (logPriority !== "all" && entry.priority !== logPriority) return false;
      if (!needle) return true;
      return `${entry.tag} ${entry.message} ${entry.pid ?? ""} ${entry.tid ?? ""}`
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [displayedLogs, logPriority, logQuery]);

  const toggleLogsPaused = () => {
    if (logsPaused) {
      setPausedLogs(null);
      setLogsPaused(false);
    } else {
      setPausedLogs(logs);
      setLogsPaused(true);
    }
  };

  const clearLogs = () => {
    setLogs([]);
    if (logsPaused) setPausedLogs([]);
  };

  const copyVisibleLogs = async () => {
    const value = filteredLogs
      .map(
        (entry) =>
          `${entry.timestamp} ${entry.priority}/${entry.tag}(${entry.pid ?? "-"}:${entry.tid ?? "-"}) ${entry.message}`,
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${filteredLogs.length} log${filteredLogs.length === 1 ? "" : "s"} copied`);
    } catch (reason) {
      setCopyStatus("Copy unavailable");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

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
          {remoteAccess?.active && (
            <span className="demo-badge" role="status">
              Remote access · expires {new Date(remoteAccess.expiresAt!).toLocaleTimeString()}
            </span>
          )}
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
          <button
            aria-label="Back"
            title="Back"
            onClick={() => void action({ type: "key", key: "back" })}
          >
            <ArrowLeft aria-hidden="true" />
          </button>
          <button
            aria-label="Home"
            title="Home"
            onClick={() => void action({ type: "key", key: "home" })}
          >
            <House aria-hidden="true" />
          </button>
          <button
            aria-label="Recents"
            title="Recents"
            onClick={() => void action({ type: "key", key: "recents" })}
          >
            <Stack aria-hidden="true" />
          </button>
          <span className="rule" />
          <button
            title="Rotate left"
            onClick={() => void action({ type: "rotate", orientation: "landscape-left" })}
          >
            <ArrowCounterClockwise aria-hidden="true" />
          </button>
          <button
            title="Portrait"
            onClick={() => void action({ type: "rotate", orientation: "portrait" })}
          >
            <DeviceMobile aria-hidden="true" />
          </button>
          <button
            aria-label="Power"
            title="Power"
            onClick={() => void action({ type: "key", key: "power" })}
          >
            <Power aria-hidden="true" />
          </button>
          <button
            title={audioPlaying ? "Mute audio" : "Unmute audio"}
            aria-label={audioPlaying ? "Mute device audio" : "Unmute device audio"}
            aria-pressed={audioPlaying}
            onClick={() => setAudioPlaying((value) => !value)}
          >
            {audioPlaying ? (
              <SpeakerHigh aria-hidden="true" />
            ) : (
              <SpeakerSlash aria-hidden="true" />
            )}
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
          <p className="hint">
            {audioStatus} · Drop an APK to install · Drop any other file to push to Downloads
          </p>
        </div>

        <aside className="inspector">
          <div className="tabs" role="tablist">
            <button className={panel === "logs" ? "active" : ""} onClick={() => setPanel("logs")}>
              Logcat <em>{logs.length}</em>
            </button>
            <button className={panel === "tree" ? "active" : ""} onClick={() => setPanel("tree")}>
              UI tree <em>{observation?.elements.length ?? 0}</em>
            </button>
          </div>
          {panel === "logs" ? (
            <div className="log-console">
              <div className="log-tools" aria-label="Logcat controls">
                <label className="log-search">
                  <MagnifyingGlass aria-hidden="true" />
                  <span className="sr-only">Search Logcat</span>
                  <input
                    aria-label="Search Logcat"
                    placeholder="Search tag or message"
                    value={logQuery}
                    onChange={(event) => setLogQuery(event.target.value)}
                  />
                </label>
                <label className="priority-filter">
                  <span className="sr-only">Filter Logcat priority</span>
                  <select
                    aria-label="Logcat priority"
                    value={logPriority}
                    onChange={(event) => setLogPriority(event.target.value as LogPriority)}
                  >
                    <option value="all">All levels</option>
                    <option value="V">Verbose</option>
                    <option value="D">Debug</option>
                    <option value="I">Info</option>
                    <option value="W">Warning</option>
                    <option value="E">Error</option>
                    <option value="F">Fatal</option>
                  </select>
                </label>
                <button
                  aria-label={logsPaused ? "Resume Logcat" : "Pause Logcat"}
                  aria-pressed={logsPaused}
                  title={logsPaused ? "Resume Logcat" : "Pause Logcat"}
                  onClick={toggleLogsPaused}
                >
                  {logsPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                </button>
                <button aria-label="Clear Logcat" title="Clear Logcat" onClick={clearLogs}>
                  <Trash aria-hidden="true" />
                </button>
                <button
                  aria-label={copyStatus}
                  title={copyStatus}
                  disabled={filteredLogs.length === 0}
                  onClick={() => void copyVisibleLogs()}
                >
                  <Copy aria-hidden="true" />
                </button>
              </div>
              <div className="log-summary" aria-live="polite">
                <span>
                  {filteredLogs.length} of {displayedLogs.length} entries
                </span>
                <span className={logsPaused ? "paused" : "live"}>
                  {logsPaused ? "Paused" : "Live"}
                </span>
              </div>
              <div className="logs">
                {displayedLogs.length === 0 && <p className="empty">Waiting for app logs.</p>}
                {displayedLogs.length > 0 && filteredLogs.length === 0 && (
                  <p className="empty">No logs match these filters.</p>
                )}
                {filteredLogs.map((entry) => (
                  <div className={`log p-${entry.priority}`} key={entry.cursor}>
                    <time>{entry.timestamp.slice(11, 23)}</time>
                    <b>
                      {entry.priority}/{entry.tag}
                    </b>
                    <span>{entry.message}</span>
                  </div>
                ))}
              </div>
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
        <button onClick={() => void refresh()}>
          <ArrowsClockwise aria-hidden="true" />
          Refresh observation
        </button>
      </footer>
    </main>
  );
}
