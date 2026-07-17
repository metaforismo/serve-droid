import type { AdbRunner } from "./adb.js";
import { checkedRun } from "./adb.js";
import { AndroidActions } from "./actions.js";
import { getDisplayInfo, listDevices, selectDevice } from "./devices.js";
import { LogBuffer, parseLogLine } from "./logs.js";
import { parseUiHierarchy } from "./ui-tree.js";
import { ServeDroidError } from "./errors.js";
import type {
  DeviceSummary,
  DisplayInfo,
  ForegroundApp,
  LogEntry,
  Observation,
  UiElement,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

const HIERARCHY_CAPTURE_ATTEMPTS = 2;

interface HierarchySnapshot {
  display: DisplayInfo;
  foregroundApp: ForegroundApp;
  elements: UiElement[];
}

function sameDisplay(left: DisplayInfo, right: DisplayInfo): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.orientation === right.orientation
  );
}

function sameForeground(left: ForegroundApp, right: ForegroundApp): boolean {
  return (
    left.packageName === right.packageName &&
    left.activity === right.activity &&
    left.pid === right.pid
  );
}

function hierarchyMatchesForeground(elements: readonly UiElement[], foreground: ForegroundApp) {
  if (!foreground.packageName) return true;
  const packages = new Set(elements.map((element) => element.packageName).filter(Boolean));
  return packages.size === 0 || packages.has(foreground.packageName);
}

export function parseForeground(output: string): Omit<ForegroundApp, "pid"> {
  const component = findForegroundComponent(output);
  return {
    packageName: component?.packageName ?? null,
    activity: component?.activity ?? null,
  };
}

function findForegroundComponent(output: string): { packageName: string; activity: string } | null {
  const resumedMarker = "mResumedActivity";
  const topMarker = "topResumedActivity";
  let resumedPosition = output.indexOf(resumedMarker);
  let topPosition = output.indexOf(topMarker);
  while (resumedPosition >= 0 || topPosition >= 0) {
    const useResumed = resumedPosition >= 0 && (topPosition < 0 || resumedPosition < topPosition);
    const marker = useResumed ? resumedMarker : topMarker;
    const markerIndex = useResumed ? resumedPosition : topPosition;
    const lineEnd = output.indexOf("\n", markerIndex);
    const end = Math.min(lineEnd < 0 ? output.length : lineEnd, markerIndex + 4096);
    const component = scanComponent(output.slice(markerIndex + marker.length, end));
    if (component) return component;
    if (useResumed)
      resumedPosition = output.indexOf(resumedMarker, markerIndex + resumedMarker.length);
    else topPosition = output.indexOf(topMarker, markerIndex + topMarker.length);
  }
  return null;
}

function isComponentCharacter(value: string, allowDollar: boolean): boolean {
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    value === "_" ||
    value === "." ||
    (allowDollar && value === "$")
  );
}

function scanComponent(value: string): { packageName: string; activity: string } | null {
  let slash = value.indexOf("/");
  while (slash >= 0) {
    let packageStart = slash;
    while (packageStart > 0 && isComponentCharacter(value[packageStart - 1]!, false))
      packageStart -= 1;
    let activityEnd = slash + 1;
    while (activityEnd < value.length && isComponentCharacter(value[activityEnd]!, true))
      activityEnd += 1;
    if (packageStart < slash && activityEnd > slash + 1) {
      return {
        packageName: value.slice(packageStart, slash),
        activity: value.slice(slash + 1, activityEnd),
      };
    }
    slash = value.indexOf("/", slash + 1);
  }
  return null;
}

export class AndroidService {
  public readonly logs = new LogBuffer();
  public readonly actions: AndroidActions;
  readonly #packagePids = new Map<string, number | null>();
  readonly #packagePidRefreshes = new Map<string, Promise<number | null>>();

  public constructor(
    public readonly adb: AdbRunner,
    public readonly device: DeviceSummary,
  ) {
    this.actions = new AndroidActions(
      adb,
      device.serial,
      () => getDisplayInfo(adb, device.serial),
      {
        onPackageProcessChanged: (packageName, state) =>
          this.#packageProcessChanged(packageName, state),
      },
    );
  }

  public static async connect(adb: AdbRunner, selector?: string): Promise<AndroidService> {
    return new AndroidService(adb, selectDevice(await listDevices(adb), selector));
  }

  public startLogs(): void {
    this.logs.start(this.adb, this.device.serial);
  }

  public stop(): void {
    this.logs.stop();
  }

  async #packageProcessChanged(packageName: string, state: "started" | "stopped"): Promise<void> {
    if (!this.#packagePids.has(packageName)) return;
    const active = this.#packagePidRefreshes.get(packageName);
    if (state === "stopped") {
      await active;
      this.#packagePids.set(packageName, null);
      return;
    }
    this.#packagePids.set(packageName, null);
    await this.#packagePid(packageName, true);
  }

  async #packagePid(packageName: string, force = false): Promise<number | null> {
    const cached = this.#packagePids.get(packageName);
    if (!force && cached) return cached;
    const active = this.#packagePidRefreshes.get(packageName);
    if (active) {
      return force ? active.then(() => this.#packagePid(packageName, true)) : active;
    }
    const refresh = this.adb
      .run(["shell", "pidof", packageName], { serial: this.device.serial })
      .then((result) => {
        const pid =
          result.exitCode === 0
            ? Number.parseInt(result.stdout.trim().split(/\s+/u)[0] ?? "", 10) || null
            : null;
        this.#packagePids.set(packageName, pid);
        return pid;
      })
      .finally(() => this.#packagePidRefreshes.delete(packageName));
    this.#packagePidRefreshes.set(packageName, refresh);
    return refresh;
  }

  public async readLogs(
    since = "0",
    packageName?: string,
  ): Promise<{ entries: LogEntry[]; nextCursor: string }> {
    if (!packageName) return this.logs.read(since);
    const pid = await this.#packagePid(packageName);
    const snapshot = this.logs.read(since);
    return {
      entries: pid ? snapshot.entries.filter((entry) => entry.pid === pid) : [],
      nextCursor: snapshot.nextCursor,
    };
  }

  public subscribeLogs(
    packageName: string | undefined,
    listener: (entry: LogEntry) => void,
  ): () => void {
    const onEntry = (entry: LogEntry) => {
      if (!packageName) {
        listener(entry);
        return;
      }
      const pid = this.#packagePids.get(packageName);
      if (pid === entry.pid) {
        listener(entry);
        return;
      }
      if (!pid) {
        void this.#packagePid(packageName).then((refreshedPid) => {
          if (refreshedPid === entry.pid) listener(entry);
        });
      }
    };
    this.logs.on("entry", onEntry);
    return () => this.logs.off("entry", onEntry);
  }

  public async foreground(): Promise<ForegroundApp> {
    const output = await checkedRun(this.adb, ["shell", "dumpsys", "activity", "activities"], {
      serial: this.device.serial,
    });
    const foreground = parseForeground(output);
    if (!foreground.packageName) return { ...foreground, pid: null };
    const pidResult = await this.adb.run(["shell", "pidof", foreground.packageName], {
      serial: this.device.serial,
    });
    return {
      ...foreground,
      pid:
        pidResult.exitCode === 0
          ? Number.parseInt(pidResult.stdout.trim().split(/\s+/u)[0] ?? "", 10) || null
          : null,
    };
  }

  async #dumpHierarchy(display: DisplayInfo): Promise<UiElement[]> {
    const xml = await checkedRun(this.adb, ["exec-out", "uiautomator", "dump", "/dev/tty"], {
      serial: this.device.serial,
      timeoutMs: 10_000,
    });
    const start = xml.indexOf("<?xml");
    return parseUiHierarchy(start >= 0 ? xml.slice(start) : xml, display);
  }

  async #freshHierarchy(): Promise<HierarchySnapshot> {
    let lastBefore: Pick<HierarchySnapshot, "display" | "foregroundApp"> | undefined;
    let lastAfter: Pick<HierarchySnapshot, "display" | "foregroundApp"> | undefined;
    for (let attempt = 0; attempt < HIERARCHY_CAPTURE_ATTEMPTS; attempt += 1) {
      const [display, foregroundApp] = await Promise.all([
        getDisplayInfo(this.adb, this.device.serial),
        this.foreground(),
      ]);
      const elements = await this.#dumpHierarchy(display);
      const [nextDisplay, nextForegroundApp] = await Promise.all([
        getDisplayInfo(this.adb, this.device.serial),
        this.foreground(),
      ]);
      if (
        sameDisplay(display, nextDisplay) &&
        sameForeground(foregroundApp, nextForegroundApp) &&
        hierarchyMatchesForeground(elements, nextForegroundApp)
      ) {
        return { display: nextDisplay, foregroundApp: nextForegroundApp, elements };
      }
      lastBefore = { display, foregroundApp };
      lastAfter = { display: nextDisplay, foregroundApp: nextForegroundApp };
    }
    throw new ServeDroidError(
      "TRANSPORT_FAILED",
      "UI hierarchy did not stabilize after a display, foreground-app, or package change.",
      { attempts: HIERARCHY_CAPTURE_ATTEMPTS, before: lastBefore, after: lastAfter },
    );
  }

  public async tree(): Promise<UiElement[]> {
    return (await this.#freshHierarchy()).elements;
  }

  public async screenshot(options: { width?: number; quality?: number } = {}): Promise<Buffer> {
    const png = await this.adb.capture(["exec-out", "screencap", "-p"], {
      serial: this.device.serial,
      timeoutMs: 10_000,
    });
    const { default: sharp } = await import("sharp");
    const pipeline = sharp(png).rotate();
    if (options.width) pipeline.resize({ width: options.width, withoutEnlargement: true });
    return pipeline.jpeg({ quality: options.quality ?? 80 }).toBuffer();
  }

  public async logSnapshot(
    options: { packageName?: string; since?: string; limit?: number } = {},
  ): Promise<{ entries: LogEntry[]; nextCursor: string }> {
    const limit = Math.max(1, Math.min(5_000, options.limit ?? 500));
    const output = await checkedRun(
      this.adb,
      ["logcat", "-d", "-v", "threadtime", "-t", String(limit)],
      { serial: this.device.serial, timeoutMs: 10_000 },
    );
    let pid: number | undefined;
    if (options.packageName) {
      const result = await this.adb.run(["shell", "pidof", options.packageName], {
        serial: this.device.serial,
      });
      if (result.exitCode !== 0) return { entries: [], nextCursor: String(limit) };
      pid = Number.parseInt(result.stdout.trim().split(/\s+/u)[0] ?? "", 10) || undefined;
    }
    const since = Number.parseInt(options.since ?? "0", 10) || 0;
    const lines = output.split(/\r?\n/u);
    const entries = lines
      .map((line, index) => parseLogLine(line, index + 1))
      .filter((entry): entry is LogEntry => entry !== null)
      .filter((entry) => Number(entry.cursor) > since && (!pid || entry.pid === pid));
    return { entries, nextCursor: String(lines.length) };
  }

  public async observe(logsSince = "0"): Promise<Omit<Observation, "screenshot">> {
    const { display, foregroundApp, elements } = await this.#freshHierarchy();
    const logs = this.logs.read(logsSince, foregroundApp.pid ?? undefined);
    return {
      schemaVersion: SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      device: this.device,
      display,
      foregroundApp,
      elements,
      logs: logs.entries,
      nextLogCursor: logs.nextCursor,
    };
  }
}
