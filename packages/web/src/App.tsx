import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowsClockwise,
  ClipboardText,
  Copy,
  CursorClick,
  DeviceMobile,
  House,
  MagnifyingGlass,
  Pause,
  Play,
  Power,
  ShieldCheck,
  SpeakerHigh,
  SpeakerSlash,
  Stack,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import {
  action,
  api,
  authenticatedWebSocket,
  hasAuthenticationToken,
  screenshot,
  upload,
  type LogEntry,
  type Observation,
  type RemoteAccess,
  type UiElement,
  type UploadProgress,
} from "./api.js";
import { createH264CanvasPlayer, type CanvasPlayer } from "./video.js";
import { nextAudioReconnectDelay, OpusAudioPlayer } from "./audio.js";

type Panel = "logs" | "tree";
type LogPriority = "all" | "V" | "D" | "I" | "W" | "E" | "F";
interface PointerGesture {
  pointerId: number;
  startedAt: number;
  startX: number;
  startY: number;
}

const demoMode = new URLSearchParams(location.search).has("demo");
const loopbackDemoMode = demoMode && ["127.0.0.1", "localhost", "::1"].includes(location.hostname);

function label(element: UiElement): string {
  return element.text || element.contentDescription || element.resourceId || element.className;
}

export function App() {
  return hasAuthenticationToken || loopbackDemoMode ? <Cockpit /> : <TokenEntry />;
}

function TokenEntry() {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  const connect = (event: React.FormEvent) => {
    event.preventDefault();
    const token = value.trim();
    if (!token || token.length > 512 || /\s/u.test(token)) {
      setError("Enter the session token exactly as it was printed by serve-droid.");
      return;
    }
    const fragment = new URLSearchParams({ token });
    history.replaceState(null, "", `${location.pathname}${location.search}#${fragment.toString()}`);
    window.location.reload();
  };

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-mark" aria-hidden="true">
          <ShieldCheck />
        </div>
        <p className="eyebrow">Protected Android session</p>
        <h1 id="auth-title">Enter the session token</h1>
        <p>
          This cockpit is not running on the same computer. Paste the token shown by the serve-droid
          host to connect securely.
        </p>
        <form onSubmit={connect}>
          <label htmlFor="session-token">Session token</label>
          <input
            id="session-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError("");
            }}
            placeholder="Paste token"
            autoFocus
          />
          {error && (
            <span className="auth-error" role="alert">
              {error}
            </span>
          )}
          <button type="submit">Connect to device</button>
        </form>
        <p className="auth-note">
          The token stays in the URL fragment only long enough to load this page. It is never sent
          in the HTTP request URL or saved to browser storage.
        </p>
      </section>
    </main>
  );
}

function Cockpit() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pointerGesture = useRef<PointerGesture | null>(null);
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
  const [transfer, setTransfer] = useState<
    | (Omit<UploadProgress, "phase"> & {
        phase: UploadProgress["phase"] | "complete";
        fileName: string;
        operation: "install" | "push";
      })
    | null
  >(null);
  const [decoder, setDecoder] = useState<"WebCodecs" | "TinyH264" | "">("");
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioStatus, setAudioStatus] = useState("Audio muted");
  const [remoteAccess, setRemoteAccess] = useState<RemoteAccess | null>(null);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [clipboardText, setClipboardText] = useState("");
  const [clipboardStatus, setClipboardStatus] = useState("Paste text into the focused field");
  const [inputStatus, setInputStatus] = useState("Click to tap · drag to swipe");
  const [pointerPreview, setPointerPreview] = useState<{
    x: number;
    y: number;
    dragging: boolean;
  } | null>(null);

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

  useEffect(() => {
    if (transfer?.phase !== "complete") return;
    const timer = window.setTimeout(() => setTransfer(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [transfer?.phase]);

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

  const readBrowserClipboard = async () => {
    try {
      const value = await navigator.clipboard.readText();
      setClipboardText(value);
      setClipboardStatus(value ? "Browser clipboard loaded" : "Browser clipboard is empty");
    } catch (reason) {
      setClipboardStatus("Clipboard read unavailable. Paste into the box instead.");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const pasteToDevice = async () => {
    if (!clipboardText) return;
    if (/[^\u0020-\u007e]/u.test(clipboardText)) {
      setClipboardStatus("Direct device paste currently supports printable ASCII only.");
      return;
    }
    try {
      await action({ type: "type", text: clipboardText });
      setClipboardStatus(
        `${clipboardText.length} character${clipboardText.length === 1 ? "" : "s"} sent`,
      );
      setClipboardText("");
      await refresh();
    } catch (reason) {
      setClipboardStatus("Device paste failed");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const runDeviceAction = async (body: Record<string, unknown>, success: string) => {
    try {
      setError("");
      await action(body);
      setInputStatus(success);
      await refresh();
    } catch (reason) {
      setInputStatus("Device action failed");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const pointerPoint = (event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  };

  const startPointerGesture = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    const point = pointerPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerGesture.current = {
      pointerId: event.pointerId,
      startedAt: performance.now(),
      startX: point.x,
      startY: point.y,
    };
    setPointerPreview({ ...point, dragging: false });
    setInputStatus("Touch held");
  };

  const movePointerGesture = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = pointerGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = pointerPoint(event);
    const bounds = event.currentTarget.getBoundingClientRect();
    const distance = Math.hypot(
      (point.x - gesture.startX) * bounds.width,
      (point.y - gesture.startY) * bounds.height,
    );
    setPointerPreview({ ...point, dragging: distance >= 10 });
    setInputStatus(distance >= 10 ? "Release to swipe" : "Release to tap");
  };

  const finishPointerGesture = async (event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = pointerGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    pointerGesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const point = pointerPoint(event);
    const bounds = event.currentTarget.getBoundingClientRect();
    const distance = Math.hypot(
      (point.x - gesture.startX) * bounds.width,
      (point.y - gesture.startY) * bounds.height,
    );
    try {
      if (distance < 10) {
        setInputStatus("Sending tap…");
        await action({ type: "tap", x: point.x, y: point.y });
        setInputStatus("Tap sent");
      } else {
        const durationMs = Math.min(
          3_000,
          Math.max(50, Math.round(performance.now() - gesture.startedAt)),
        );
        setInputStatus("Sending swipe…");
        await action({
          type: "swipe",
          x1: gesture.startX,
          y1: gesture.startY,
          x2: point.x,
          y2: point.y,
          durationMs,
        });
        setInputStatus("Swipe sent");
      }
      await refresh();
    } catch (reason) {
      setInputStatus("Input failed");
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPointerPreview(null);
    }
  };

  const cancelPointerGesture = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointerGesture.current?.pointerId !== event.pointerId) return;
    pointerGesture.current = null;
    setPointerPreview(null);
    setInputStatus("Gesture cancelled");
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

  const transferFile = async (file: File) => {
    const operation = file.name.toLocaleLowerCase().endsWith(".apk") ? "install" : "push";
    setError("");
    try {
      const result = await upload(file, (progress) =>
        setTransfer({ ...progress, fileName: file.name, operation }),
      );
      setTransfer((current) =>
        current ? { ...current, phase: "complete", loaded: file.size, percent: 100 } : current,
      );
      setStatus(result.operation === "install" ? "APK installed" : "File pushed");
    } catch (reason) {
      setTransfer(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) await transferFile(file);
  };

  return (
    <main
      className="shell"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => void onDrop(event)}
    >
      <input
        ref={fileInput}
        className="sr-only"
        type="file"
        aria-label="Choose APK or file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void transferFile(file);
          event.currentTarget.value = "";
        }}
      />
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
          <div>
            <strong>Connection needs attention</strong>
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => void refresh()}>
            Retry
          </button>
          <button type="button" aria-label="Dismiss error" onClick={() => setError("")}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}
      {transfer && (
        <div className="drop-status" role="status" aria-live="polite">
          <div>
            <strong>
              {transfer.phase === "complete"
                ? transfer.operation === "install"
                  ? `Installed ${transfer.fileName}`
                  : `Pushed ${transfer.fileName} to Downloads`
                : transfer.phase === "uploading"
                  ? `Uploading ${transfer.fileName}`
                  : transfer.operation === "install"
                    ? `Installing ${transfer.fileName} on device`
                    : `Pushing ${transfer.fileName} to Downloads`}
            </strong>
            <span>
              {transfer.phase === "complete"
                ? "Done"
                : transfer.phase === "uploading"
                  ? `${transfer.percent}%`
                  : "Finishing with ADB"}
            </span>
          </div>
          <progress
            aria-label={`Transfer progress for ${transfer.fileName}`}
            max={100}
            value={transfer.percent}
          />
        </div>
      )}

      <section className="workspace">
        <aside className="device-sidebar" aria-label="Device controls">
          <div className="sidebar-heading">
            <span>Device</span>
            <strong>Active session</strong>
          </div>
          <article className="device-card">
            <span className="device-icon" aria-hidden="true">
              <DeviceMobile />
            </span>
            <div>
              <strong>{observation?.device.model ?? "Waiting for device"}</strong>
              <span>{observation?.device.serial ?? "ADB session starting"}</span>
            </div>
            <i className={error ? "offline" : ""} aria-hidden="true" />
          </article>
          <dl className="device-facts">
            <div>
              <dt>Android</dt>
              <dd>{observation ? `API ${observation.device.apiLevel}` : "—"}</dd>
            </div>
            <div>
              <dt>Display</dt>
              <dd>
                {observation ? `${observation.display.width}×${observation.display.height}` : "—"}
              </dd>
            </div>
          </dl>
          <section className="control-group">
            <h2>Navigation</h2>
            <div className="control-grid">
              <button
                title="Back"
                aria-label="Back"
                onClick={() => void runDeviceAction({ type: "key", key: "back" }, "Back sent")}
              >
                <ArrowLeft aria-hidden="true" />
                <span>Back</span>
              </button>
              <button
                title="Home"
                aria-label="Home"
                onClick={() => void runDeviceAction({ type: "key", key: "home" }, "Home sent")}
              >
                <House aria-hidden="true" />
                <span>Home</span>
              </button>
              <button
                title="Recents"
                aria-label="Recents"
                onClick={() =>
                  void runDeviceAction({ type: "key", key: "recents" }, "Recents sent")
                }
              >
                <Stack aria-hidden="true" />
                <span>Recents</span>
              </button>
              <button
                title="Power"
                aria-label="Power"
                onClick={() => void runDeviceAction({ type: "key", key: "power" }, "Power sent")}
              >
                <Power aria-hidden="true" />
                <span>Power</span>
              </button>
            </div>
          </section>
          <section className="control-group">
            <h2>Device tools</h2>
            <div className="control-grid">
              <button
                title="Rotate left"
                aria-label="Rotate left"
                onClick={() =>
                  void runDeviceAction(
                    { type: "rotate", orientation: "landscape-left" },
                    "Landscape requested",
                  )
                }
              >
                <ArrowCounterClockwise aria-hidden="true" />
                <span>Rotate</span>
              </button>
              <button
                title="Portrait"
                aria-label="Portrait"
                onClick={() =>
                  void runDeviceAction(
                    { type: "rotate", orientation: "portrait" },
                    "Portrait requested",
                  )
                }
              >
                <DeviceMobile aria-hidden="true" />
                <span>Portrait</span>
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
                <span>Audio</span>
              </button>
              <button
                title="Paste text"
                aria-label="Open device clipboard"
                aria-expanded={clipboardOpen}
                onClick={() => setClipboardOpen((value) => !value)}
              >
                <ClipboardText aria-hidden="true" />
                <span>Paste</span>
              </button>
              <button
                className="wide-control"
                title="Upload APK or file"
                aria-label="Upload APK or file"
                onClick={() => fileInput.current?.click()}
              >
                <UploadSimple aria-hidden="true" />
                <span>Install APK or push file</span>
              </button>
            </div>
          </section>
          <p className="sidebar-footnote">
            <CursorClick aria-hidden="true" /> Pointer input uses normalized device coordinates.
          </p>
        </aside>

        <div className="stage">
          <div className="stage-session" aria-live="polite">
            <span>
              <i /> {status}
            </span>
            <strong>{observation?.device.model ?? "Android device"}</strong>
          </div>
          <div
            className={`phone ${observation?.display.orientation !== "portrait" ? "landscape" : ""}`}
          >
            {previewUrl && frames === 0 && (
              <img src={previewUrl} alt="Current Android device screenshot" />
            )}
            <canvas
              ref={canvas}
              aria-label="Live Android device. Click to tap or drag to swipe."
              onPointerDown={startPointerGesture}
              onPointerMove={movePointerGesture}
              onPointerUp={(event) => void finishPointerGesture(event)}
              onPointerCancel={cancelPointerGesture}
            />
            {pointerPreview && (
              <span
                className={`touch-indicator ${pointerPreview.dragging ? "dragging" : ""}`}
                style={{ left: `${pointerPreview.x * 100}%`, top: `${pointerPreview.y * 100}%` }}
              />
            )}
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
          <div className="stage-hints">
            <span>
              <CursorClick aria-hidden="true" /> {inputStatus}
            </span>
            <span>{audioStatus}</span>
            <span>Drop APK or files anywhere</span>
          </div>
          {clipboardOpen && (
            <section className="clipboard-card" aria-label="Device clipboard">
              <div>
                <strong>Paste to device</strong>
                <span aria-live="polite">{clipboardStatus}</span>
              </div>
              <textarea
                aria-label="Text to paste into device"
                placeholder="Paste or type printable ASCII text"
                value={clipboardText}
                onChange={(event) => setClipboardText(event.target.value)}
                rows={3}
              />
              <div className="clipboard-actions">
                <button type="button" onClick={() => void readBrowserClipboard()}>
                  Load browser clipboard
                </button>
                <button
                  type="button"
                  disabled={!clipboardText}
                  onClick={() => void pasteToDevice()}
                >
                  Send to focused field
                </button>
              </div>
            </section>
          )}
        </div>

        <aside className="inspector">
          <div className="inspector-heading">
            <div>
              <span>Inspector</span>
              <strong>Agent context</strong>
            </div>
            <small>{panel === "logs" ? "Live Logcat" : "Semantic UI"}</small>
          </div>
          <div className="tabs" role="tablist">
            <button
              role="tab"
              aria-selected={panel === "logs"}
              className={panel === "logs" ? "active" : ""}
              onClick={() => setPanel("logs")}
            >
              Logcat <em>{logs.length}</em>
            </button>
            <button
              role="tab"
              aria-selected={panel === "tree"}
              className={panel === "tree" ? "active" : ""}
              onClick={() => setPanel("tree")}
            >
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
