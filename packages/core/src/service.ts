import type { AdbRunner } from "./adb.js";
import { checkedRun } from "./adb.js";
import { AndroidActions } from "./actions.js";
import { getDisplayInfo, listDevices, selectDevice } from "./devices.js";
import { LogBuffer, parseLogLine } from "./logs.js";
import { parseUiHierarchy } from "./ui-tree.js";
import type { DeviceSummary, ForegroundApp, LogEntry, Observation, UiElement } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export function parseForeground(output: string): Omit<ForegroundApp, "pid"> {
  const component = output.match(
    /(?:mResumedActivity|topResumedActivity)[^\n]*?\s([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.$]+)/u,
  );
  return {
    packageName: component?.[1] ?? null,
    activity: component?.[2] ?? null,
  };
}

export class AndroidService {
  public readonly logs = new LogBuffer();
  public readonly actions: AndroidActions;

  public constructor(
    public readonly adb: AdbRunner,
    public readonly device: DeviceSummary,
  ) {
    this.actions = new AndroidActions(adb, device.serial, () => getDisplayInfo(adb, device.serial));
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

  public async tree(): Promise<UiElement[]> {
    const display = await getDisplayInfo(this.adb, this.device.serial);
    const xml = await checkedRun(this.adb, ["exec-out", "uiautomator", "dump", "/dev/tty"], {
      serial: this.device.serial,
      timeoutMs: 10_000,
    });
    const start = xml.indexOf("<?xml");
    return parseUiHierarchy(start >= 0 ? xml.slice(start) : xml, display);
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
    const display = await getDisplayInfo(this.adb, this.device.serial);
    const [foregroundApp, elements] = await Promise.all([this.foreground(), this.tree()]);
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
