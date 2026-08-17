import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ServeDroidError } from "@serve-droid/core";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 10;
const MAX_REPORT_BYTES = 8 * 1024;
const MAX_USER_AGENT_LENGTH = 512;

export interface BrowserCapabilities {
  userAgent: string;
  secureContext: boolean;
  fetch: boolean;
  webSocket: boolean;
  webAssembly: boolean;
  worker: boolean;
  canvas2d: boolean;
  webgl: boolean;
  webCodecs: boolean;
  clipboardRead: boolean;
  fileApi: boolean;
}

export type BrowserDecoder = "webcodecs" | "tinyh264" | "unavailable";

export interface BrowserProbeResult {
  capabilities: BrowserCapabilities;
  control: boolean;
  decoder: BrowserDecoder;
  ready: boolean;
  warnings: string[];
}

export interface BrowserProbeOptions {
  timeoutMs?: number;
  launch?: (url: string) => Promise<void> | void;
}

class ProbeHttpError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function booleanCapability(record: Record<string, unknown>, name: string): boolean {
  const value = record[name];
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

export function parseBrowserCapabilities(value: unknown): BrowserCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Capability report must be an object.");
  }
  const record = value as Record<string, unknown>;
  const userAgent = record.userAgent;
  if (
    typeof userAgent !== "string" ||
    userAgent.length < 1 ||
    userAgent.length > MAX_USER_AGENT_LENGTH
  ) {
    throw new Error(`userAgent must contain 1 to ${MAX_USER_AGENT_LENGTH} characters.`);
  }
  return {
    userAgent,
    secureContext: booleanCapability(record, "secureContext"),
    fetch: booleanCapability(record, "fetch"),
    webSocket: booleanCapability(record, "webSocket"),
    webAssembly: booleanCapability(record, "webAssembly"),
    worker: booleanCapability(record, "worker"),
    canvas2d: booleanCapability(record, "canvas2d"),
    webgl: booleanCapability(record, "webgl"),
    webCodecs: booleanCapability(record, "webCodecs"),
    clipboardRead: booleanCapability(record, "clipboardRead"),
    fileApi: booleanCapability(record, "fileApi"),
  };
}

export function classifyBrowserCapabilities(capabilities: BrowserCapabilities): BrowserProbeResult {
  const control = capabilities.fetch && capabilities.webSocket;
  const decoder: BrowserDecoder =
    capabilities.webCodecs && capabilities.canvas2d
      ? "webcodecs"
      : capabilities.webAssembly &&
          capabilities.worker &&
          capabilities.canvas2d &&
          capabilities.webgl
        ? "tinyh264"
        : "unavailable";
  const warnings: string[] = [];
  if (!control) warnings.push("Authenticated control requires Fetch and WebSocket support.");
  if (decoder === "unavailable") {
    warnings.push(
      "Video requires H.264 WebCodecs or the WebAssembly, Worker, Canvas 2D, and WebGL fallback capabilities.",
    );
  }
  if (!capabilities.secureContext) {
    warnings.push("The page is not a secure context; clipboard APIs may be restricted.");
  }
  if (!capabilities.clipboardRead) {
    warnings.push(
      "Clipboard API loading is unavailable; manual clipboard entry remains available.",
    );
  }
  if (!capabilities.fileApi) {
    warnings.push("Browser file APIs are unavailable; drag-and-drop upload is not supported.");
  }
  return {
    capabilities,
    control,
    decoder,
    ready: control && decoder !== "unavailable",
    warnings,
  };
}

function escapedHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function browserProbeHtml(resultPath: string, nonce: string): string {
  const encodedResultPath = JSON.stringify(resultPath);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>serve-droid browser probe</title>
  <style nonce="${escapedHtml(nonce)}">
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 44rem; margin: 10vh auto; padding: 0 1.5rem; line-height: 1.5; }
    code { overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <h1>serve-droid browser capability probe</h1>
    <p id="status" role="status" aria-live="polite">Checking this browser locally…</p>
    <p>No browser data is sent outside this one-time loopback server.</p>
  </main>
  <script nonce="${escapedHtml(nonce)}">
    (async () => {
      const status = document.getElementById("status");
      const canvas2dElement = document.createElement("canvas");
      const webglElement = document.createElement("canvas");
      let webCodecs = false;
      try {
        if (typeof VideoDecoder === "function") {
          if (typeof VideoDecoder.isConfigSupported === "function") {
            const support = await VideoDecoder.isConfigSupported({
              codec: "avc1.42C028",
              optimizeForLatency: true,
              hardwareAcceleration: "prefer-hardware",
            });
            webCodecs = Boolean(support.supported);
          } else {
            webCodecs = true;
          }
        }
      } catch {
        webCodecs = false;
      }
      const report = {
        userAgent: String(navigator.userAgent || "unknown").slice(0, ${MAX_USER_AGENT_LENGTH}),
        secureContext: Boolean(globalThis.isSecureContext),
        fetch: typeof fetch === "function",
        webSocket: typeof WebSocket === "function",
        webAssembly: typeof WebAssembly === "object",
        worker: typeof Worker === "function",
        canvas2d: Boolean(canvas2dElement.getContext("2d")),
        webgl: Boolean(webglElement.getContext("webgl2") || webglElement.getContext("webgl")),
        webCodecs,
        clipboardRead: Boolean(navigator.clipboard && typeof navigator.clipboard.readText === "function"),
        fileApi:
          typeof File === "function" &&
          typeof Blob === "function" &&
          typeof FileReader === "function" &&
          typeof DataTransfer === "function",
      };
      const body = JSON.stringify(report);
      const postWithXhr = () =>
        new Promise((resolve, reject) => {
          const request = new XMLHttpRequest();
          request.open("POST", ${encodedResultPath}, true);
          request.setRequestHeader("content-type", "application/json");
          request.onload = () =>
            request.status >= 200 && request.status < 300
              ? resolve(undefined)
              : reject(new Error("Probe server rejected the report."));
          request.onerror = () => reject(new Error("Probe server was unreachable."));
          request.send(body);
        });
      try {
        if (typeof fetch === "function") {
          const response = await fetch(${encodedResultPath}, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            cache: "no-store",
            credentials: "omit",
          });
          if (!response.ok) throw new Error("Probe server rejected the report.");
        } else {
          await postWithXhr();
        }
        status.textContent = "Probe complete. You may close this tab.";
        document.title = "serve-droid probe complete";
      } catch {
        status.textContent = "The local probe could not return its result. Retry serve-droid doctor --browser.";
        document.title = "serve-droid probe failed";
      }
    })();
  </script>
</body>
</html>`;
}

async function readReport(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > MAX_REPORT_BYTES) {
      throw new ProbeHttpError(413, "Capability report is too large.");
    }
    chunks.push(buffer);
  }
  if (!chunks.length) throw new ProbeHttpError(400, "Capability report is empty.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ProbeHttpError(400, "Capability report is not valid JSON.");
  }
}

function commonHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function textResponse(response: ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, {
    ...commonHeaders(),
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(message);
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

function launchCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

export function launchDefaultBrowser(url: string): Promise<void> {
  const { command, args } = launchCommand(url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => reject(error));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function boundedTimeout(value: number): number {
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      `Browser probe timeout must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms.`,
    );
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function probeBrowser(options: BrowserProbeOptions = {}): Promise<BrowserProbeResult> {
  const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const token = randomBytes(24).toString("hex");
  const nonce = randomBytes(18).toString("base64url");
  const pagePath = `/${token}`;
  const resultPath = `${pagePath}/result`;
  let expectedHost = "";
  let expectedOrigin = "";
  let settled = false;
  let resolveResult: (result: BrowserProbeResult) => void = () => undefined;
  let rejectResult: (error: Error) => void = () => undefined;
  const resultPromise = new Promise<BrowserProbeResult>((resolve, reject) => {
    resolveResult = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    rejectResult = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
  });
  // A custom launcher may wait for the POST response before returning. Attach a handler
  // immediately so an invalid report is never temporarily unhandled; callers still await
  // the original promise below and receive the typed failure.
  void resultPromise.catch(() => undefined);

  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", expectedOrigin || "http://127.0.0.1");
      if (expectedHost && request.headers.host !== expectedHost) {
        textResponse(response, 421, "Unexpected host.");
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === pagePath) {
        const html = browserProbeHtml(resultPath, nonce);
        response.writeHead(200, {
          ...commonHeaders(),
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
          "content-type": "text/html; charset=utf-8",
        });
        response.end(html);
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === resultPath) {
        if (settled) {
          textResponse(response, 409, "Probe is already complete.");
          return;
        }
        const contentType = String(request.headers["content-type"] ?? "");
        if (!contentType.toLowerCase().startsWith("application/json")) {
          throw new ProbeHttpError(415, "Capability report must be JSON.");
        }
        const origin = request.headers.origin;
        if (origin && origin !== expectedOrigin) {
          throw new ProbeHttpError(403, "Capability report origin is invalid.");
        }
        const capabilities = parseBrowserCapabilities(await readReport(request));
        response.once("finish", () => resolveResult(classifyBrowserCapabilities(capabilities)));
        response.writeHead(204, commonHeaders());
        response.end();
        return;
      }
      textResponse(response, 404, "Not found.");
    })().catch((error: unknown) => {
      const statusCode = error instanceof ProbeHttpError ? error.statusCode : 400;
      if (!response.headersSent) textResponse(response, statusCode, "Invalid capability report.");
      else response.end();
      rejectResult(
        new ServeDroidError("TRANSPORT_FAILED", "Browser returned an invalid capability report.", {
          cause: errorMessage(error).slice(0, 160),
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    const startupError = (error: Error) => reject(error);
    server.once("error", startupError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", startupError);
      resolve();
    });
  });
  server.on("error", (error) =>
    rejectResult(
      new ServeDroidError("TRANSPORT_FAILED", "Browser probe server failed.", {
        cause: error.message.slice(0, 160),
      }),
    ),
  );

  const address = server.address() as AddressInfo;
  expectedHost = `127.0.0.1:${address.port}`;
  expectedOrigin = `http://${expectedHost}`;
  const url = `${expectedOrigin}${pagePath}`;
  const timeout = setTimeout(() => {
    rejectResult(
      new ServeDroidError(
        "TRANSPORT_FAILED",
        `Browser probe timed out after ${timeoutMs} ms. Close the probe tab and retry.`,
        { timeoutMs },
      ),
    );
  }, timeoutMs);
  timeout.unref();

  try {
    try {
      await (options.launch ?? launchDefaultBrowser)(url);
    } catch (error) {
      rejectResult(
        new ServeDroidError("TRANSPORT_FAILED", "Could not open the default browser.", {
          cause: errorMessage(error).slice(0, 160),
        }),
      );
    }
    return await resultPromise;
  } finally {
    clearTimeout(timeout);
    await closeServer(server);
  }
}
