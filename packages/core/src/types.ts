export const SCHEMA_VERSION = 1 as const;

export type DeviceState = "device" | "offline" | "unauthorized" | "unknown";
export type DeviceKind = "emulator" | "physical";
export type Orientation = "portrait" | "landscape-left" | "landscape-right";

export interface DeviceSummary {
  serial: string;
  state: DeviceState;
  kind: DeviceKind;
  model: string | null;
  product: string | null;
  manufacturer: string | null;
  apiLevel: number | null;
  abi: string | null;
}

export interface DisplayInfo {
  width: number;
  height: number;
  density: number | null;
  orientation: Orientation;
}

export interface NormalizedBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface UiElement {
  id: string;
  parentId: string | null;
  className: string;
  text: string;
  contentDescription: string;
  resourceId: string;
  packageName: string;
  bounds: NormalizedBounds;
  enabled: boolean;
  clickable: boolean;
  focusable: boolean;
  scrollable: boolean;
  selected: boolean;
  checked: boolean;
}

export interface ForegroundApp {
  packageName: string | null;
  activity: string | null;
  pid: number | null;
}

export interface LogEntry {
  cursor: string;
  timestamp: string;
  pid: number;
  tid: number;
  priority: string;
  tag: string;
  message: string;
}

export interface ScreenshotInfo {
  mimeType: "image/jpeg";
  width: number;
  height: number;
  url: string;
}

export interface Observation {
  schemaVersion: typeof SCHEMA_VERSION;
  timestamp: string;
  device: DeviceSummary;
  display: DisplayInfo;
  foregroundApp: ForegroundApp;
  screenshot: ScreenshotInfo;
  elements: UiElement[];
  logs: LogEntry[];
  nextLogCursor: string;
}

export interface GesturePoint {
  x: number;
  y: number;
  durationMs?: number;
}

export interface Gesture {
  points: GesturePoint[];
}

export interface SessionInfo {
  schemaVersion: typeof SCHEMA_VERSION;
  device: DeviceSummary;
  display: DisplayInfo;
  pid: number;
  host: string;
  port: number;
  url: string;
  token: string;
  startedAt: string;
  recordingDirectory?: string;
}
