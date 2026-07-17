import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, extname, join, normalize, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  SCHEMA_VERSION,
  ServeDroidError,
  getDisplayInfo,
  listDevices,
  type AndroidService,
  type Gesture,
  type SessionInfo,
} from "@serve-droid/core";
import { ScrcpyH264Source, type VideoSource } from "./video.js";
import { removeSessionState, writeSessionState } from "./state.js";

const JSON_LIMIT = 1024 * 1024;
const FILE_LIMIT = 256 * 1024 * 1024;

export interface ServerOptions {
  host?: string;
  port?: number;
  token?: string;
  webRoot?: string;
  videoSource?: VideoSource;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function errorBody(error: unknown) {
  if (error instanceof ServeDroidError) {
    return {
      schemaVersion: SCHEMA_VERSION,
      error: { code: error.code, message: error.message, details: error.details },
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    error: {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "Unknown error",
    },
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function defaultWebRoot(): string {
  const candidates = [
    resolve(import.meta.dirname, "../../web/dist"),
    resolve(import.meta.dirname, "../packages/web/dist"),
  ];
  return (
    candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? candidates[0]!
  );
}

async function readBody(request: IncomingMessage, limit = JSON_LIMIT): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > limit) throw new ServeDroidError("INVALID_ARGUMENT", "Request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  try {
    return JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new ServeDroidError("INVALID_ARGUMENT", "Request body must be valid JSON.");
  }
}

export class ServeDroidServer {
  readonly #http;
  readonly #videoWebSocket: WebSocketServer;
  readonly #controlWebSocket: WebSocketServer;
  readonly #video: VideoSource;
  readonly #token: string;
  readonly #host: string;
  readonly #requestedPort: number;
  readonly #webRoot: string;
  #session: SessionInfo | undefined;
  #stopping = false;

  public constructor(
    public readonly service: AndroidService,
    options: ServerOptions = {},
  ) {
    this.#host = options.host ?? "127.0.0.1";
    this.#requestedPort = options.port ?? 0;
    this.#token = options.token ?? randomBytes(32).toString("base64url");
    this.#webRoot = options.webRoot ?? defaultWebRoot();
    this.#http = createServer((request, response) => void this.#handle(request, response));
    this.#videoWebSocket = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.#controlWebSocket = new WebSocketServer({ noServer: true, maxPayload: JSON_LIMIT });
    this.#video = options.videoSource ?? new ScrcpyH264Source(service.device.serial);
    this.#video.on("data", (chunk) => {
      for (const client of this.#videoWebSocket.clients) {
        if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 4 * 1024 * 1024)
          client.send(chunk);
      }
    });
    this.#video.on("error", (error) => {
      for (const client of this.#videoWebSocket.clients) {
        if (client.readyState === WebSocket.OPEN) client.close(1011, error.message.slice(0, 120));
      }
    });
    this.#http.on("upgrade", (request, socket, head) => this.#upgrade(request, socket, head));
    this.#controlWebSocket.on("connection", (socket) => {
      socket.on("message", (message) => {
        const value = Buffer.isBuffer(message)
          ? message.toString("utf8")
          : Buffer.from(message as ArrayBuffer).toString("utf8");
        void this.#handleControl(socket, value);
      });
    });
  }

  public get token(): string {
    return this.#token;
  }

  public async start(): Promise<SessionInfo> {
    if (this.#session) return this.#session;
    await new Promise<void>((resolvePromise, reject) => {
      this.#http.once("error", reject);
      this.#http.listen(this.#requestedPort, this.#host, () => resolvePromise());
    });
    const address = this.#http.address() as AddressInfo;
    const display = await getDisplayInfo(this.service.adb, this.service.device.serial);
    const shownHost = this.#host === "0.0.0.0" ? "127.0.0.1" : this.#host;
    this.#session = {
      schemaVersion: SCHEMA_VERSION,
      device: this.service.device,
      display,
      pid: process.pid,
      host: this.#host,
      port: address.port,
      url: `http://${shownHost}:${address.port}`,
      token: this.#token,
      startedAt: new Date().toISOString(),
    };
    try {
      this.service.startLogs();
      await this.#video.start();
      await writeSessionState(this.#session);
      return this.#session;
    } catch (error) {
      this.#session = undefined;
      this.service.stop();
      await this.#video.stop().catch(() => undefined);
      await new Promise<void>((resolvePromise) => this.#http.close(() => resolvePromise()));
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    await this.#video.stop();
    this.service.stop();
    for (const client of [...this.#videoWebSocket.clients, ...this.#controlWebSocket.clients])
      client.close(1001);
    await new Promise<void>((resolvePromise) => this.#http.close(() => resolvePromise()));
    await removeSessionState(this.service.device.serial);
    this.#session = undefined;
  }

  #authenticated(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization ?? "";
    if (authorization.startsWith("Bearer ") && safeEqual(authorization.slice(7), this.#token))
      return true;
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim());
    const protocolToken = protocols.find((value) => value.startsWith("token."))?.slice(6);
    return Boolean(protocolToken && safeEqual(protocolToken, this.#token));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; connect-src 'self' ws:; img-src 'self' blob: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    );
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    try {
      if (url.pathname === "/api/v1/health") {
        json(response, 200, { schemaVersion: SCHEMA_VERSION, status: "ok" });
        return;
      }
      if (url.pathname === "/" && request.method === "GET") {
        await this.#serveIndex(request, response);
        return;
      }
      if (url.pathname.startsWith("/assets/") && request.method === "GET") {
        await this.#serveAsset(url.pathname, response);
        return;
      }
      if (!this.#authenticated(request)) {
        json(
          response,
          401,
          errorBody(
            new ServeDroidError("AUTHENTICATION_REQUIRED", "A valid bearer token is required."),
          ),
        );
        return;
      }
      if (url.pathname === "/api/v1/devices" && request.method === "GET") {
        json(response, 200, {
          schemaVersion: SCHEMA_VERSION,
          devices: await listDevices(this.service.adb),
        });
      } else if (url.pathname === "/api/v1/session" && request.method === "GET") {
        json(response, 200, this.#session ? { ...this.#session, token: undefined } : null);
      } else if (url.pathname === "/api/v1/tree" && request.method === "GET") {
        json(response, 200, { schemaVersion: SCHEMA_VERSION, elements: await this.service.tree() });
      } else if (url.pathname === "/api/v1/screenshot" && request.method === "GET") {
        const jpeg = await this.service.screenshot();
        response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
        response.end(jpeg);
      } else if (url.pathname === "/api/v1/observe" && request.method === "GET") {
        const observation = await this.service.observe(url.searchParams.get("logsSince") ?? "0");
        json(response, 200, {
          ...observation,
          screenshot: {
            mimeType: "image/jpeg",
            width: observation.display.width,
            height: observation.display.height,
            url: "/api/v1/screenshot",
          },
        });
      } else if (url.pathname === "/api/v1/logs" && request.method === "GET") {
        this.#serveLogs(request, response, url.searchParams.get("since") ?? "0");
      } else if (url.pathname === "/api/v1/actions" && request.method === "POST") {
        json(response, 200, await this.#action(await readJson(request)));
      } else if (url.pathname === "/api/v1/apps" && request.method === "POST") {
        json(response, 200, await this.#app(await readJson(request)));
      } else if (url.pathname === "/api/v1/permissions" && request.method === "POST") {
        json(response, 200, await this.#permission(await readJson(request)));
      } else if (url.pathname === "/api/v1/files" && request.method === "POST") {
        json(response, 200, await this.#file(request));
      } else {
        json(response, 404, {
          schemaVersion: SCHEMA_VERSION,
          error: { code: "NOT_FOUND", message: "Route not found." },
        });
      }
    } catch (error) {
      json(response, error instanceof ServeDroidError ? 400 : 500, errorBody(error));
    }
  }

  async #serveIndex(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const index = await readFile(join(this.#webRoot, "index.html"), "utf8");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        index.replace(
          "__SERVE_DROID_BOOTSTRAP__",
          JSON.stringify({ token: this.#isLoopbackRequest(request) ? this.#token : "" }),
        ),
      );
    } catch {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("serve-droid web UI has not been built. Run pnpm build.");
    }
  }

  #isLoopbackRequest(request: IncomingMessage): boolean {
    const address = request.socket.remoteAddress ?? "";
    return address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
  }

  async #serveAsset(pathname: string, response: ServerResponse): Promise<void> {
    const relative = normalize(pathname.slice(1));
    const path = resolve(this.#webRoot, relative);
    if (!path.startsWith(resolve(this.#webRoot)) || !(await stat(path)).isFile()) {
      json(response, 404, { error: { code: "NOT_FOUND", message: "Asset not found." } });
      return;
    }
    const types: Record<string, string> = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
    };
    response.writeHead(200, {
      "content-type": types[extname(path)] ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    });
    createReadStream(path).pipe(response);
  }

  #serveLogs(request: IncomingMessage, response: ServerResponse, since: string): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const write = (entry: unknown) => response.write(`data: ${JSON.stringify(entry)}\n\n`);
    for (const entry of this.service.logs.read(since).entries) write(entry);
    this.service.logs.on("entry", write);
    request.once("close", () => this.service.logs.off("entry", write));
  }

  async #action(body: Record<string, unknown>): Promise<unknown> {
    const type = stringValue(body.type);
    if (type === "tap") await this.service.actions.tap(Number(body.x), Number(body.y));
    else if (type === "swipe")
      await this.service.actions.swipe(
        Number(body.x1),
        Number(body.y1),
        Number(body.x2),
        Number(body.y2),
        Number(body.durationMs ?? 300),
      );
    else if (type === "gesture") await this.service.actions.gesture(body.gesture as Gesture);
    else if (type === "type") await this.service.actions.typeText(stringValue(body.text));
    else if (type === "key") await this.service.actions.key(body.key as never);
    else if (type === "rotate") await this.service.actions.rotate(body.orientation as never);
    else throw new ServeDroidError("INVALID_ARGUMENT", `Unsupported action '${type}'.`);
    return { schemaVersion: SCHEMA_VERSION, ok: true };
  }

  async #app(body: Record<string, unknown>): Promise<unknown> {
    const operation = stringValue(body.operation);
    const packageName = stringValue(body.packageName);
    if (operation === "install") await this.service.actions.install(stringValue(body.path));
    else if (operation === "launch")
      await this.service.actions.launch(packageName, stringValue(body.activity) || undefined);
    else if (operation === "stop") await this.service.actions.stop(packageName);
    else if (operation === "clear") await this.service.actions.clear(packageName);
    else if (operation === "uninstall") await this.service.actions.uninstall(packageName);
    else if (operation === "deep-link")
      await this.service.actions.deepLink(stringValue(body.url), packageName || undefined);
    else throw new ServeDroidError("INVALID_ARGUMENT", `Unsupported app operation '${operation}'.`);
    return { schemaVersion: SCHEMA_VERSION, ok: true };
  }

  async #permission(body: Record<string, unknown>): Promise<unknown> {
    const output = await this.service.actions.permission(
      stringValue(body.operation) as never,
      stringValue(body.permission),
      stringValue(body.packageName),
    );
    return { schemaVersion: SCHEMA_VERSION, ok: true, output };
  }

  async #file(request: IncomingMessage): Promise<unknown> {
    const encodedName = String(request.headers["x-file-name"] ?? "");
    const name = basename(decodeURIComponent(encodedName));
    if (!name || name === "." || name === "..")
      throw new ServeDroidError("INVALID_ARGUMENT", "x-file-name is required.");
    const directory = await mkdtemp(join(tmpdir(), "serve-droid-upload-"));
    const path = join(directory, name);
    try {
      await writeFile(path, await readBody(request, FILE_LIMIT), { flag: "wx", mode: 0o600 });
      if (name.toLocaleLowerCase().endsWith(".apk")) {
        await this.service.actions.install(path);
        return { schemaVersion: SCHEMA_VERSION, ok: true, operation: "install" };
      }
      const destination = await this.service.actions.push(path);
      return { schemaVersion: SCHEMA_VERSION, ok: true, operation: "push", destination };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (!this.#authenticated(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const server =
      url.pathname === "/api/v1/video"
        ? this.#videoWebSocket
        : url.pathname === "/api/v1/control"
          ? this.#controlWebSocket
          : null;
    if (!server) {
      socket.destroy();
      return;
    }
    server.handleUpgrade(request, socket, head, (client) =>
      server.emit("connection", client, request),
    );
  }

  async #handleControl(socket: WebSocket, raw: string): Promise<void> {
    try {
      const result = await this.#action(JSON.parse(raw) as Record<string, unknown>);
      socket.send(JSON.stringify(result));
    } catch (error) {
      socket.send(JSON.stringify(errorBody(error)));
    }
  }
}
