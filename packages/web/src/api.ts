const fragment = new URLSearchParams(location.hash.replace(/^#/u, ""));
const token = window.__SERVE_DROID__?.token || fragment.get("token") || "";
if (fragment.has("token")) history.replaceState(null, "", `${location.pathname}${location.search}`);

export const hasAuthenticationToken = token.length > 0;

export interface Bounds {
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
  bounds: Bounds;
  clickable: boolean;
  enabled: boolean;
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

export interface Observation {
  schemaVersion: 1;
  timestamp: string;
  device: { serial: string; model: string | null; apiLevel: number | null; kind: string };
  display: { width: number; height: number; orientation: string };
  foregroundApp: { packageName: string | null; activity: string | null };
  screenshot: { mimeType: "image/jpeg"; width: number; height: number; url: string };
  elements: UiElement[];
  logs: LogEntry[];
  nextLogCursor: string;
}

export interface RemoteAccess {
  schemaVersion: 1;
  active: boolean;
  provider: "cloudflare" | null;
  publicUrl: string | null;
  expiresAt: string | null;
}

export async function screenshot(url: string): Promise<Blob> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Screenshot request failed (${response.status})`);
  return response.blob();
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body instanceof Blob ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const body = (await response.json()) as T & { error?: { message: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  return body;
}

export async function action(body: Record<string, unknown>): Promise<void> {
  await api("/api/v1/actions", { method: "POST", body: JSON.stringify(body) });
}

export async function upload(file: File): Promise<void> {
  await api("/api/v1/files", {
    method: "POST",
    headers: {
      "x-file-name": encodeURIComponent(file.name),
      "content-type": "application/octet-stream",
    },
    body: file,
  });
}

export function authenticatedWebSocket(path: string): WebSocket {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${location.host}${path}`, ["serve-droid", `token.${token}`]);
}
