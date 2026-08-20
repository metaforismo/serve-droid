import { useMemo, useState } from "react";
import { Copy, MagnifyingGlass, Pause, Play, Trash } from "@phosphor-icons/react";
import type { LogEntry, UiElement } from "./api.js";
import { ActivityPanel } from "./ActivityPanel.js";

type Panel = "logs" | "tree" | "activity";
type LogPriority = "all" | "V" | "D" | "I" | "W" | "E" | "F";

function label(element: UiElement): string {
  return element.text || element.contentDescription || element.resourceId || element.className;
}

export interface InspectorProps {
  active: boolean;
  logs: LogEntry[];
  elements: UiElement[];
  selected: UiElement | null;
  onSelect: (element: UiElement) => void;
  onTapElement: (element: UiElement) => Promise<void>;
  onClearLogs: () => void;
  onError: (message: string) => void;
}

export function Inspector({
  active,
  logs,
  elements,
  selected,
  onSelect,
  onTapElement,
  onClearLogs,
  onError,
}: InspectorProps) {
  const [panel, setPanel] = useState<Panel>("logs");
  const [logQuery, setLogQuery] = useState("");
  const [logPriority, setLogPriority] = useState<LogPriority>("all");
  const [logsPaused, setLogsPaused] = useState(false);
  const [pausedLogs, setPausedLogs] = useState<LogEntry[] | null>(null);
  const [copyStatus, setCopyStatus] = useState("Copy visible logs");
  const [query, setQuery] = useState("");

  const filteredElements = useMemo(() => {
    const needle = query.toLocaleLowerCase();
    return elements.filter((element) => label(element).toLocaleLowerCase().includes(needle));
  }, [elements, query]);

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
      return;
    }
    setPausedLogs(logs);
    setLogsPaused(true);
  };

  const clearLogs = () => {
    onClearLogs();
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
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <div>
          <span>Inspector</span>
          <strong>Agent context</strong>
        </div>
        <small>
          {panel === "logs" ? "Live Logcat" : panel === "tree" ? "Semantic UI" : "Session Activity"}
        </small>
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
          UI tree <em>{elements.length}</em>
        </button>
        <button
          role="tab"
          aria-selected={panel === "activity"}
          className={panel === "activity" ? "active" : ""}
          onClick={() => setPanel("activity")}
        >
          Activity
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
            <span className={logsPaused ? "paused" : "live"}>{logsPaused ? "Paused" : "Live"}</span>
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
      ) : panel === "tree" ? (
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
                onMouseEnter={() => onSelect(element)}
                onFocus={() => onSelect(element)}
                onClick={() => void onTapElement(element)}
              >
                <strong>{label(element) || "Unnamed element"}</strong>
                <span>
                  {element.className.split(".").at(-1)} · {element.resourceId || "no id"}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ActivityPanel active={active} />
      )}
    </aside>
  );
}
