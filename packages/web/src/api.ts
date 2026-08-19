import { createSseParser } from "./sse.js";

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
  phase: "uploading" | "processing" | "installing" | "pushing";
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

interface FileProgressEvent {
  schemaVersion: 1;
  type: "file-progress";
  operation: "install" | "push";
  phase: "installing" | "pushing" | "completed" | "failed";
  message: string;
}

interface ErrorEnvelope {
  error?: { message?: string };
}

export function upload(
  file: File,
  onProgress: (progress: UploadProgress) => void = () => undefined,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let responseOffset = 0;
    let result: UploadResult | undefined;
    let streamError: Error | undefined;
    let parseError: Error | undefined;
    const parser = createSseParser((event) => {
      try {
        if (event.event === "progress") {
          const progress = JSON.parse(event.data) as FileProgressEvent;
          if (
            progress.type === "file-progress" &&
            (progress.phase === "installing" || progress.phase === "pushing")
          ) {
            onProgress({
              phase: progress.phase,
              loaded: file.size,
              total: file.size,
              percent: 100,
            });
          }
        } else if (event.event === "result") {
          result = JSON.parse(event.data) as UploadResult;
        } else if (event.event === "error") {
          const body = JSON.parse(event.data) as ErrorEnvelope;
          streamError = new Error(body.error?.message ?? "Android file operation failed.");
        }
      } catch {
        parseError = new Error("Upload progress stream contained invalid JSON.");
      }
    });

    const consumeResponse = () => {
      const chunk = request.responseText.slice(responseOffset);
      responseOffset = request.responseText.length;
      if (chunk) parser.push(chunk);
    };

    request.open("POST", "/api/v1/files");
    request.setRequestHeader("authorization", `Bearer ${token}`);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.setRequestHeader("accept", "text/event-stream");
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
    request.addEventListener("progress", consumeResponse);
    request.addEventListener("load", () => {
      consumeResponse();
      parser.finish();
      if (parseError) {
        reject(parseError);
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        let body: ErrorEnvelope = {};
        try {
          body = JSON.parse(request.responseText) as ErrorEnvelope;
        } catch {
          // The status code remains the useful fallback when the pre-stream response is not JSON.
        }
        reject(new Error(body.error?.message ?? `Upload failed (${request.status})`));
        return;
      }
      if (streamError) {
        reject(streamError);
        return;
      }
      if (result) {
        resolve(result);
        return;
      }
      try {
        const body = JSON.parse(request.responseText) as UploadResult;
        if (body.ok === true && (body.operation === "install" || body.operation === "push")) {
          resolve(body);
          return;
        }
      } catch {
        // A current server should have returned an SSE result event.
      }
      reject(new Error(`Upload returned an invalid response (${request.status})`));
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
