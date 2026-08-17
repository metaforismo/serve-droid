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

export interface UploadProgress {
  phase: "uploading" | "processing";
  loaded: number;
  total: number;
  percent: number;
}

export interface UploadResult {
  schemaVersion: 1;
  ok: true;
  operation: "install" | "push";
  destination?: string;
}

export function upload(
  file: File,
  onProgress: (progress: UploadProgress) => void = () => undefined,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/v1/files");
    request.setRequestHeader("authorization", `Bearer ${token}`);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    request.upload.addEventListener("progress", (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : file.size;
      const loaded = Math.min(event.loaded, total);
      onProgress({
        phase: total > 0 && loaded >= total ? "processing" : "uploading",
        loaded,
        total,
        percent: total > 0 ? Math.round((loaded / total) * 100) : 0,
      });
    });
    request.upload.addEventListener("load", () => {
      onProgress({ phase: "processing", loaded: file.size, total: file.size, percent: 100 });
    });
    request.addEventListener("load", () => {
      let body: UploadResult & { error?: { message: string } };
      try {
        body = JSON.parse(request.responseText) as typeof body;
      } catch {
        reject(new Error(`Upload returned an invalid response (${request.status})`));
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(body.error?.message ?? `Upload failed (${request.status})`));
        return;
      }
      resolve(body);
    });
    request.addEventListener("error", () => reject(new Error("Upload connection failed.")));
    request.addEventListener("abort", () => reject(new Error("Upload was cancelled.")));
    onProgress({ phase: "uploading", loaded: 0, total: file.size, percent: 0 });
    request.send(file);
  });
}

export function authenticatedWebSocket(path: string): WebSocket {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${location.host}${path}`, ["serve-droid", `token.${token}`]);
}
