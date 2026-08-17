import { basename } from "node:path";
import type { AdbRunner } from "./adb.js";
import { checkedRun } from "./adb.js";
import { ServeDroidError } from "./errors.js";
import type { DisplayInfo, Gesture, GesturePoint, GestureStreamPhase } from "./types.js";

const ROTATION_TIMEOUT_MS = 5_000;
const ROTATION_POLL_MS = 100;
const MAX_GESTURE_POINTS = 64;
const MAX_GESTURE_DURATION_MS = 60_000;
const GESTURE_STREAM_ID = /^[A-Za-z0-9_-]{16,128}$/u;
const GESTURE_STREAM_PHASES: readonly GestureStreamPhase[] = ["begin", "move", "end", "cancel"];

export interface ValidatedGestureStream {
  id: string;
  phase: GestureStreamPhase;
  point: GesturePoint;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertCoordinate(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ServeDroidError("INVALID_ARGUMENT", `${name} must be a number between 0 and 1.`);
  }
}

function assertDuration(value: number, name = "durationMs"): void {
  if (!Number.isInteger(value) || value < 1 || value > 60_000) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      `${name} must be an integer between 1 and 60000.`,
    );
  }
}

export function validateGestureStream(gesture: Gesture): ValidatedGestureStream | null {
  const stream = gesture?.stream;
  if (stream === undefined) return null;
  if (!gesture || !Array.isArray(gesture.points)) {
    throw new ServeDroidError("INVALID_ARGUMENT", "A gesture must contain a points array.");
  }
  if (gesture.secondaryPoints !== undefined) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      "A live pointer stream must not include secondaryPoints.",
    );
  }
  if (!stream || typeof stream !== "object") {
    throw new ServeDroidError("INVALID_ARGUMENT", "A gesture stream descriptor is invalid.");
  }
  if (typeof stream.id !== "string" || !GESTURE_STREAM_ID.test(stream.id)) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      "A gesture stream id must contain 16 to 128 URL-safe characters.",
    );
  }
  if (!GESTURE_STREAM_PHASES.includes(stream.phase)) {
    throw new ServeDroidError("INVALID_ARGUMENT", "A gesture stream phase is invalid.");
  }
  if (gesture.points.length !== 1) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      "A gesture stream message must contain exactly one point.",
    );
  }
  const point = gesture.points[0];
  if (!point || typeof point !== "object") {
    throw new ServeDroidError("INVALID_ARGUMENT", "gesture.points[0] must be an object.");
  }
  assertCoordinate(point.x, "gesture.points[0].x");
  assertCoordinate(point.y, "gesture.points[0].y");
  if (point.durationMs !== undefined) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      "A gesture stream point must not include durationMs.",
    );
  }
  return { id: stream.id, phase: stream.phase, point };
}

export function validateGesture(gesture: Gesture): Gesture {
  if (!gesture || !Array.isArray(gesture.points)) {
    throw new ServeDroidError("INVALID_ARGUMENT", "A gesture must contain a points array.");
  }
  if (gesture.stream) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      "A streaming gesture must use the live pointer control path.",
    );
  }
  if (gesture.points.length < 2) {
    throw new ServeDroidError("INVALID_ARGUMENT", "A gesture requires at least two points.");
  }
  if (gesture.points.length > MAX_GESTURE_POINTS) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      `A gesture must not exceed ${MAX_GESTURE_POINTS} points.`,
    );
  }

  let totalDurationMs = 0;
  for (const [index, point] of gesture.points.entries()) {
    if (!point || typeof point !== "object") {
      throw new ServeDroidError("INVALID_ARGUMENT", `gesture.points[${index}] must be an object.`);
    }
    assertCoordinate(point.x, `gesture.points[${index}].x`);
    assertCoordinate(point.y, `gesture.points[${index}].y`);
    if (point.durationMs !== undefined) {
      assertDuration(point.durationMs, `gesture.points[${index}].durationMs`);
    }
    if (index > 0) totalDurationMs += point.durationMs ?? 100;
  }

  if (totalDurationMs > MAX_GESTURE_DURATION_MS) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      `A gesture must not exceed ${MAX_GESTURE_DURATION_MS} ms in total.`,
    );
  }

  if (gesture.secondaryPoints !== undefined) {
    if (!Array.isArray(gesture.secondaryPoints)) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "gesture.secondaryPoints must be an array when provided.",
      );
    }
    if (gesture.secondaryPoints.length !== gesture.points.length) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "A two-finger gesture requires points and secondaryPoints to have the same length.",
      );
    }
    for (const [index, point] of gesture.secondaryPoints.entries()) {
      if (!point || typeof point !== "object") {
        throw new ServeDroidError(
          "INVALID_ARGUMENT",
          `gesture.secondaryPoints[${index}] must be an object.`,
        );
      }
      assertCoordinate(point.x, `gesture.secondaryPoints[${index}].x`);
      assertCoordinate(point.y, `gesture.secondaryPoints[${index}].y`);
      if ("durationMs" in point) {
        throw new ServeDroidError(
          "INVALID_ARGUMENT",
          "secondaryPoints must not include durationMs; the primary points define the shared timeline.",
        );
      }
    }
  }

  return gesture;
}

function pixel(value: number, size: number): string {
  return String(Math.round(value * size));
}

const KEY_CODES = {
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  recents: "KEYCODE_APP_SWITCH",
  power: "KEYCODE_POWER",
  "volume-up": "KEYCODE_VOLUME_UP",
  "volume-down": "KEYCODE_VOLUME_DOWN",
  enter: "KEYCODE_ENTER",
} as const;

const PERMISSIONS: Record<string, string> = {
  camera: "android.permission.CAMERA",
  microphone: "android.permission.RECORD_AUDIO",
  location: "android.permission.ACCESS_FINE_LOCATION",
  contacts: "android.permission.READ_CONTACTS",
  calendar: "android.permission.READ_CALENDAR",
};

export interface AndroidActionHooks {
  onPackageProcessChanged?: (
    packageName: string,
    state: "started" | "stopped",
  ) => void | Promise<void>;
}

export class AndroidActions {
  public constructor(
    private readonly adb: AdbRunner,
    public readonly serial: string,
    private readonly getDisplay: () => Promise<DisplayInfo>,
    private readonly hooks: AndroidActionHooks = {},
  ) {}

  public async tap(x: number, y: number): Promise<void> {
    assertCoordinate(x, "x");
    assertCoordinate(y, "y");
    const display = await this.getDisplay();
    await checkedRun(
      this.adb,
      ["shell", "input", "tap", pixel(x, display.width), pixel(y, display.height)],
      {
        serial: this.serial,
      },
    );
  }

  public async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs = 300,
  ): Promise<void> {
    [x1, y1, x2, y2].forEach((value, index) => assertCoordinate(value, `coordinate ${index + 1}`));
    assertDuration(durationMs);
    const display = await this.getDisplay();
    await checkedRun(
      this.adb,
      [
        "shell",
        "input",
        "swipe",
        pixel(x1, display.width),
        pixel(y1, display.height),
        pixel(x2, display.width),
        pixel(y2, display.height),
        String(durationMs),
      ],
      { serial: this.serial },
    );
  }

  public async gesture(gesture: Gesture): Promise<void> {
    const stream = validateGestureStream(gesture);
    if (stream) {
      throw new ServeDroidError(
        "TRANSPORT_FAILED",
        "Live pointer streaming requires an active scrcpy control channel.",
        { safeToFallback: true, phase: stream.phase },
      );
    }
    const validated = validateGesture(gesture);
    if (validated.secondaryPoints !== undefined) {
      throw new ServeDroidError(
        "TRANSPORT_FAILED",
        "Two-finger gestures require an active scrcpy control channel.",
        { safeToFallback: false, pointerCount: 2 },
      );
    }
    const [first, ...rest] = validated.points;
    let current = first!;
    for (const point of rest) {
      await this.swipe(current.x, current.y, point.x, point.y, point.durationMs ?? 100);
      current = point;
    }
  }

  public async typeText(text: string): Promise<void> {
    if (!text) throw new ServeDroidError("INVALID_ARGUMENT", "Text must not be empty.");
    if (text.length > 4096) {
      throw new ServeDroidError("INVALID_ARGUMENT", "Text must not exceed 4096 characters.");
    }
    if (/[^\u0020-\u007e]/u.test(text)) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "Direct text injection supports printable ASCII only. Use the device keyboard for Unicode text.",
      );
    }
    const escaped = text.replaceAll("%", "%25").replaceAll(" ", "%s");
    await checkedRun(this.adb, ["shell", "input", "text", escaped], { serial: this.serial });
  }

  public async key(key: keyof typeof KEY_CODES): Promise<void> {
    const code = KEY_CODES[key];
    if (!code) throw new ServeDroidError("INVALID_ARGUMENT", `Unsupported key '${key}'.`);
    await checkedRun(this.adb, ["shell", "input", "keyevent", code], { serial: this.serial });
  }

  public async rotate(
    orientation: "portrait" | "landscape-left" | "landscape-right",
  ): Promise<void> {
    const value = orientation === "portrait" ? "0" : orientation === "landscape-left" ? "1" : "3";
    await checkedRun(
      this.adb,
      ["shell", "settings", "put", "system", "accelerometer_rotation", "0"],
      {
        serial: this.serial,
      },
    );
    await checkedRun(this.adb, ["shell", "settings", "put", "system", "user_rotation", value], {
      serial: this.serial,
    });
    const deadline = Date.now() + ROTATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const display = await this.getDisplay();
      if (display.orientation === orientation) return;
      await delay(ROTATION_POLL_MS);
    }
    throw new ServeDroidError(
      "ADB_FAILED",
      `Device did not report ${orientation} orientation within ${ROTATION_TIMEOUT_MS} ms.`,
      { orientation, timeoutMs: ROTATION_TIMEOUT_MS },
    );
  }

  public async install(path: string): Promise<void> {
    if (!path.toLocaleLowerCase().endsWith(".apk")) {
      throw new ServeDroidError("INVALID_ARGUMENT", "Only .apk files can be installed.");
    }
    await checkedRun(this.adb, ["install", "-r", path], {
      serial: this.serial,
      timeoutMs: 120_000,
    });
  }

  public async launch(packageName: string, activity?: string): Promise<void> {
    const args = activity
      ? ["shell", "am", "start", "-n", `${packageName}/${activity}`]
      : ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"];
    await checkedRun(this.adb, args, { serial: this.serial });
    await this.hooks.onPackageProcessChanged?.(packageName, "started");
  }

  public async stop(packageName: string): Promise<void> {
    await checkedRun(this.adb, ["shell", "am", "force-stop", packageName], { serial: this.serial });
    await this.hooks.onPackageProcessChanged?.(packageName, "stopped");
  }

  public async clear(packageName: string): Promise<void> {
    await checkedRun(this.adb, ["shell", "pm", "clear", packageName], { serial: this.serial });
    await this.hooks.onPackageProcessChanged?.(packageName, "stopped");
  }

  public async uninstall(packageName: string): Promise<void> {
    await checkedRun(this.adb, ["uninstall", packageName], { serial: this.serial });
    await this.hooks.onPackageProcessChanged?.(packageName, "stopped");
  }

  public async deepLink(url: string, packageName?: string): Promise<void> {
    const args = ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url];
    if (packageName) args.push(packageName);
    await checkedRun(this.adb, args, { serial: this.serial });
    if (packageName) await this.hooks.onPackageProcessChanged?.(packageName, "started");
  }

  public async push(localPath: string, remoteDirectory = "/sdcard/Download/"): Promise<string> {
    if (!remoteDirectory.startsWith("/sdcard/") || remoteDirectory.includes("..")) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "Remote directory must be an absolute /sdcard path.",
      );
    }
    const destination = `${remoteDirectory.replace(/\/$/u, "")}/${basename(localPath)}`;
    await checkedRun(this.adb, ["push", localPath, destination], {
      serial: this.serial,
      timeoutMs: 120_000,
    });
    return destination;
  }

  public async permission(
    operation: "grant" | "revoke" | "reset" | "list",
    permission: string,
    packageName: string,
  ): Promise<string> {
    const sdkOutput = await checkedRun(this.adb, ["shell", "getprop", "ro.build.version.sdk"], {
      serial: this.serial,
    });
    const apiLevel = Number.parseInt(sdkOutput.trim(), 10);
    const androidPermission =
      permission === "photos"
        ? apiLevel >= 33
          ? "android.permission.READ_MEDIA_IMAGES"
          : "android.permission.READ_EXTERNAL_STORAGE"
        : permission === "notifications"
          ? "android.permission.POST_NOTIFICATIONS"
          : PERMISSIONS[permission];
    if (!androidPermission) {
      throw new ServeDroidError("INVALID_ARGUMENT", `Unsupported permission '${permission}'.`);
    }
    if (permission === "notifications" && apiLevel < 33) {
      throw new ServeDroidError(
        "UNSUPPORTED_ANDROID",
        "Notification runtime permission is only available on Android API 33 and newer.",
      );
    }
    if (operation === "list") {
      const output = await checkedRun(this.adb, ["shell", "dumpsys", "package", packageName], {
        serial: this.serial,
      });
      return (
        output
          .split(/\r?\n/u)
          .filter((line) => line.includes(androidPermission))
          .map((line) => line.trim())
          .join("\n") || `${androidPermission}: not declared`
      );
    }
    if (operation === "reset") {
      const revoke = await this.adb.run(["shell", "pm", "revoke", packageName, androidPermission], {
        serial: this.serial,
      });
      const flags = await checkedRun(
        this.adb,
        [
          "shell",
          "pm",
          "clear-permission-flags",
          packageName,
          androidPermission,
          "user-set",
          "user-fixed",
        ],
        { serial: this.serial },
      );
      return [revoke.stdout, flags].filter(Boolean).join("\n");
    }
    return checkedRun(this.adb, ["shell", "pm", operation, packageName, androidPermission], {
      serial: this.serial,
    });
  }
}
