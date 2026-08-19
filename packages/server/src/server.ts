import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
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
import {
  RestartingVideoSource,
  ScrcpyH264Source,
  type AudioState,
  type VideoSource,
} from "./video.js";
import { removeSessionState, writeSessionState } from "./state.js";
import {
  decodeUploadName,
  parseJsonObject,
  sseResumeCursor,
  writeSseLogFrame,
} from "./transport-boundaries.js";
import {
  SessionRecorder,
  validateRecordingOptions,
  type RecordingOptions,
  type RecordingStatus,
} from "./recording.js";
import type { TunnelStatus } from "./tunnel.js";
import { listenHttpServer } from "./listen.js";
import {
  DECODED_FRAME_DEFAULT_QUALITY,
  DECODED_FRAME_DEFAULT_WIDTH,
  DECODED_FRAME_MAX_PAYLOAD,
  DecodedFrameBroker,
  isDecodedFrameProviderHello,
  jpegDimensions,
} from "./decoded-frame.js";
import {
  acceptsFileProgressStream,
  fileProgressEvent,
  startFileProgressStream,
  writeFileProgressFrame,
  type FileOperation,
} from "./file-progress.js";

const JSON_LIMIT = 1024 * 1024;
const FILE_LIMIT = 256 * 1024 * 1024;
const DEFAULT_VIDEO_CLIENT_LIMIT = 2;
const VIDEO_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

export interface ServerOptions {
  host?: string;
  port?: number;
  token?: string;
  webRoot?: string;
  videoSource?: VideoSource;
  recording?: Omit<RecordingOptions, "serial">;
  recordingControl?: Omit<RecordingOptions, "serial">;
  audio?: boolean;
  frameAncestor?: string;
  maxVideoClients?: number;
}

export interface AgentScreenshotOptions {
  width?: number;
  quality?: number;
}

export interface AgentScreenshot {
  data: Buffer;
  mimeType: "image/jpeg";
  source: "stream" | "device";
  width: number | null;
  height: number | null;
  capturedAt: string;
}

export function encodeAudioPacket(data: Buffer, pts: bigint): Buffer {
  const packet = Buffer.allocUnsafe(8 + data.length);
  packet.writeBigInt64BE(pts, 0);
  data.copy(packet, 8);
  return packet;
}

export function canSendAudio(bufferedAmount: number): boolean {
  return Number.isFinite(bufferedAmount) && bufferedAmount >= 0 && bufferedAmount < 512 * 1024;
}

export function canSendVideo(bufferedAmount: number): boolean {
  return (
    Number.isFinite(bufferedAmount) &&
    bufferedAmount >= 0 &&
    bufferedAmount < VIDEO_BACKPRESSURE_BYTES
  );
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
      message: "The request could not be completed.",
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

function loopbackFrameAncestor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const origin = new URL(value);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== value) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      "A frame ancestor must be an exact http://127.0.0.1 origin.",
    );
  }
  return origin.origin;
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
  return parseJsonObject((await readBody(request)).toString("utf8"));
}

export class ServeDroidServer {
  readonly #http;
  readonly #videoWebSocket: WebSocketServer;
  readonly #audioWebSocket: WebSocketServer;
  readonly #controlWebSocket: WebSocketServer;
  readonly #video: VideoSource;
  readonly #decodedFrames = new DecodedFrameBroker();
  readonly #token: string;
  readonly #host: string;
  readonly #requestedPort: number;
  readonly #webRoot: string;
  readonly #frameAncestor: string | undefined;
  readonly #maxVideoClients: number;
  readonly #recordingOptions: Omit<RecordingOptions, "serial"> | undefined;
  readonly #recordingAutoStart: boolean;
  #recordingMutation: Promise<void> = Promise.resolve();
  #recorder: SessionRecorder | undefined;
  #session: SessionInfo | undefined;
  #audioState: AudioState;
  #remoteAccess: TunnelStatus = {
    active: false,
    provider: null,
    publicUrl: null,
    expiresAt: null,
  };
  #stopping = false;

  public constructor(
    public readonly service: AndroidService,
    options: ServerOptions = {},
  ) {
    this.#host = options.host ?? "127.0.0.1";
    this.#requestedPort = options.port ?? 0;
    this.#token = options.token ?? randomBytes(32).toString("base64url");
    this.#webRoot = options.webRoot ?? defaultWebRoot();
    this.#frameAncestor = loopbackFrameAncestor(options.frameAncestor);
    this.#maxVideoClients = options.maxVideoClients ?? DEFAULT_VIDEO_CLIENT_LIMIT;
    if (
      !Number.isInteger(this.#maxVideoClients) ||
      this.#maxVideoClients < 1 ||
      this.#maxVideoClients > 8
    ) {
      throw new ServeDroidError("INVALID_ARGUMENT", "maxVideoClients must be between 1 and 8.");
    }
    if (options.recording && options.recordingControl) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "Choose either recording auto-start or recording controls, not both.",
      );
    }
    this.#recordingOptions = options.recording ?? options.recordingControl;
    this.#recordingAutoStart = Boolean(options.recording);
    if (this.#recordingOptions) validateRecordingOptions(this.#recordingOptions);
    this.#http = createServer((request, response) => void this.#handle(request, response));
    this.#videoWebSocket = new WebSocketServer({
      noServer: true,
      maxPayload: DECODED_FRAME_MAX_PAYLOAD,
    });
    this.#audioWebSocket = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    this.#controlWebSocket = new WebSocketServer({ noServer: true, maxPayload: JSON_LIMIT });
    const audioRequested = Boolean(options.audio);
    const audioSupported = (service.device.apiLevel ?? 0) >= 30;
    this.#audioState = {
      enabled: audioRequested,
      available: false,
      codec: null,
      reason: !audioRequested
        ? "Audio capture was not enabled for this session."
        : !audioSupported
          ? "Android audio playback capture requires API 30 or newer."
          : "Negotiating device audio.",
    };
    this.#video =
      options.videoSource ??
      new RestartingVideoSource(
        () => new ScrcpyH264Source(service.device.serial, audioRequested && audioSupported),
      );
    this.#video.on("data", (chunk) => {
      this.#recorder?.recordVideo(chunk);
      for (const client of this.#videoWebSocket.clients) {
        if (client.readyState === WebSocket.OPEN && canSendVideo(client.bufferedAmount))
          client.send(chunk);
      }
    });
    this.#video.on("error", (error) => {
      this.#recorder?.recordEvent("video-error", { kind: error.name || "transport" });
      for (const client of this.#videoWebSocket.clients) {
        if (client.readyState === WebSocket.OPEN) client.close(1011, error.message.slice(0, 120));
      }
    });
    this.#video.on("restart", ({ attempt, maxAttempts }) => {
      this.#recorder?.recordEvent("video-restart", { attempt, maxAttempts });
    });
    this.#video.on("size", (size) => this.#recorder?.recordEvent("display-size", size));
    this.#video.on("audioState", (state) => {
      this.#audioState = state;
      const message = JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        type: "audio-state",
        ...state,
      });
      for (const client of this.#audioWebSocket.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(message);
      }
    });
    this.#video.on("audioData", ({ data, pts }) => {
      const packet = encodeAudioPacket(data, pts);
      for (const client of this.#audioWebSocket.clients) {
        if (client.readyState === WebSocket.OPEN && canSendAudio(client.bufferedAmount))
          client.send(packet);
      }
    });
    this.#http.on("upgrade", (request, socket, head) => this.#upgrade(request, socket, head));
    this.#videoWebSocket.on("connection", (socket) => {
      socket.on("error", () => undefined);
      let unregister: (() => void) | undefined;
      socket.on("message", (message, binary) => {
        if (binary) return;
        const value = Array.isArray(message)
          ? Buffer.concat(message).toString("utf8")
          : Buffer.isBuffer(message)
            ? message.toString("utf8")
            : Buffer.from(message).toString("utf8");
        if (!unregister && isDecodedFrameProviderHello(value)) {
          unregister = this.#decodedFrames.register(socket);
          return;
        }
        if (unregister) this.#decodedFrames.receive(socket, value);
      });
      socket.once("close", () => unregister?.());
    });
    this.#controlWebSocket.on("connection", (socket) => {
      socket.on("error", () => undefined);
      socket.on("message", (message) => {
        const value = Buffer.isBuffer(message)
          ? message.toString("utf8")
          : Buffer.from(message as ArrayBuffer).toString("utf8");
        void this.#handleControl(socket, value);
      });
    });
    this.#audioWebSocket.on("connection", (socket) => {
      socket.on("error", () => undefined);
      socket.send(
        JSON.stringify({ schemaVersion: SCHEMA_VERSION, type: "audio-state", ...this.#audioState }),
      );
    });
  }

  public get token(): string {
    return this.#token;
  }

  public get recording(): RecordingStatus | null {
    return this.#recorder?.status ?? null;
  }

  public get recordingControllable(): boolean {
    return Boolean(this.#recordingOptions);
  }

  async #setBrowserRecording(body: Record<string, unknown>): Promise<{
    schemaVersion: 1;
    controllable: true;
    recording: RecordingStatus | null;
  }> {
    if (this.#stopping) {
      throw new ServeDroidError("TRANSPORT_FAILED", "The session is stopping.");
    }
    if (!this.#recordingOptions) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "Browser recording controls were not authorized by the host process.",
      );
    }
    if (Object.keys(body).some((key) => key !== "active") || typeof body.active !== "boolean") {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "Recording control requires exactly one boolean active field.",
      );
    }
    if (!this.#session) {
      throw new ServeDroidError("SESSION_NOT_FOUND", "No active serve-droid session exists.");
    }

    const active = body.active;
    const operation = this.#recordingMutation.then(async () => {
      if (active) {
        if (this.#recorder?.status.active) return this.#recorder.status;
        await this.#recorder?.stop();
        const recorder = await SessionRecorder.create({
          ...this.#recordingOptions!,
          serial: this.service.device.serial,
        });
        this.#recorder = recorder;
        recorder.recordEvent("recording-start", {
          trigger: "browser",
          serial: this.service.device.serial,
          width: this.#session!.display.width,
          height: this.#session!.display.height,
        });
        this.#session!.recordingDirectory = recorder.status.directory;
        await writeSessionState(this.#session!);
        return recorder.status;
      }

      if (!this.#recorder) return null;
      if (this.#recorder.status.active) {
        this.#recorder.recordEvent("recording-stop", { trigger: "browser" });
      }
      await this.#recorder.stop();
      return this.#recorder.status;
    });
    this.#recordingMutation = operation.then(
      () => undefined,
      () => undefined,
    );
    return {
      schemaVersion: SCHEMA_VERSION,
      controllable: true,
      recording: await operation,
    };
  }

  public async captureAgentScreenshot(
    options: AgentScreenshotOptions = {},
  ): Promise<AgentScreenshot> {
    const width = options.width ?? DECODED_FRAME_DEFAULT_WIDTH;
    const quality = options.quality ?? DECODED_FRAME_DEFAULT_QUALITY;
    if (!Number.isInteger(width) || width < 1 || width > 2_048) {
      throw new ServeDroidError("INVALID_ARGUMENT", "Screenshot width must be between 1 and 2048.");
    }
    if (!Number.isInteger(quality) || quality < 25 || quality > 95) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "Screenshot quality must be between 25 and 95.",
      );
    }

    const stream = await this.#decodedFrames.capture({ maxWidth: width, quality });
    if (stream) {
      this.#recorder?.recordEvent("screenshot", {
        source: "stream",
        width: stream.width,
        height: stream.height,
      });
      return { ...stream, source: "stream" };
    }

    const data = await this.service.screenshot({ width, quality });
    const dimensions = jpegDimensions(data);
    const capture: AgentScreenshot = {
      data,
      mimeType: "image/jpeg",
      source: "device",
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      capturedAt: new Date().toISOString(),
    };
    this.#recorder?.recordEvent("screenshot", {
      source: capture.source,
      width: capture.width,
      height: capture.height,
    });
    return capture;
  }

  public async start(): Promise<SessionInfo> {
    if (this.#session) return this.#session;
    await listenHttpServer(this.#http, this.#requestedPort, this.#host);
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
      if (this.#recordingAutoStart && this.#recordingOptions) {
        this.#recorder = await SessionRecorder.create({
          ...this.#recordingOptions,
          serial: this.service.device.serial,
        });
        this.#session.recordingDirectory = this.#recorder.status.directory;
        this.#recorder.recordEvent("session-start", {
          serial: this.service.device.serial,
          width: display.width,
          height: display.height,
        });
      }
      this.service.startLogs();
      await this.#video.start();
      await writeSessionState(this.#session);
      return this.#session;
    } catch (error) {
      this.#session = undefined;
      this.service.stop();
      await this.#video.stop().catch(() => undefined);
      await this.#recorder?.stop().catch(() => undefined);
      this.#recorder = undefined;
      await new Promise<void>((resolvePromise) => this.#http.close(() => resolvePromise()));
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    await this.#recordingMutation;
    this.#decodedFrames.close();
    await this.#video.stop();
    this.#recorder?.recordEvent("session-stop");
    await this.#recorder?.stop();
    this.service.stop();
    for (const client of [
      ...this.#videoWebSocket.clients,
      ...this.#audioWebSocket.clients,
      ...this.#controlWebSocket.clients,
    ])
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
    if (!this.#frameAncestor) response.setHeader("x-frame-options", "DENY");
    response.setHeader(
      "content-security-policy",
      `default-src 'self'; connect-src 'self' ws:; img-src 'self' blob: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors ${this.#frameAncestor ?? "'none'"}`,
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
        const capture = await this.captureAgentScreenshot();
        const headers: Record<string, string> = {
          "content-type": capture.mimeType,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-serve-droid-screenshot-source": capture.source,
          "x-serve-droid-screenshot-captured-at": capture.capturedAt,
        };
        if (capture.width !== null)
          headers["x-serve-droid-screenshot-width"] = String(capture.width);
        if (capture.height !== null)
          headers["x-serve-droid-screenshot-height"] = String(capture.height);
        response.writeHead(200, headers);
        response.end(capture.data);
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
      } else if (url.pathname === "/api/v1/recording" && request.method === "GET") {
        json(response, 200, {
          schemaVersion: SCHEMA_VERSION,
          controllable: this.recordingControllable,
          recording: this.recording,
        });
      } else if (url.pathname === "/api/v1/recording" && request.method === "POST") {
        json(response, 200, await this.#setBrowserRecording(await readJson(request)));
      } else if (url.pathname === "/api/v1/remote-access" && request.method === "GET") {
        json(response, 200, { schemaVersion: SCHEMA_VERSION, ...this.#remoteAccess });
      } else if (url.pathname === "/api/v1/remote-access" && request.method === "POST") {
        json(response, 200, this.#setRemoteAccess(await readJson(request)));
      } else if (url.pathname === "/api/v1/logs" && request.method === "GET") {
        const requestedPackage = url.searchParams.get("package") || undefined;
        const systemLogs = url.searchParams.get("system") === "true";
        if (requestedPackage && systemLogs) {
          throw new ServeDroidError(
            "INVALID_ARGUMENT",
            "Choose either a package filter or system logs, not both.",
          );
        }
        const packageName = systemLogs
          ? undefined
          : requestedPackage || (await this.service.foreground()).packageName || undefined;
        await this.#serveLogs(request, response, url.searchParams.get("since") ?? "0", packageName);
      } else if (url.pathname === "/api/v1/actions" && request.method === "POST") {
        json(response, 200, await this.#action(await readJson(request)));
      } else if (url.pathname === "/api/v1/apps" && request.method === "POST") {
        json(response, 200, await this.#app(await readJson(request)));
      } else if (url.pathname === "/api/v1/permissions" && request.method === "POST") {
        json(response, 200, await this.#permission(await readJson(request)));
      } else if (url.pathname === "/api/v1/files" && request.method === "POST") {
        await this.#file(request, response);
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

  #setRemoteAccess(body: Record<string, unknown>): { schemaVersion: 1 } & TunnelStatus {
    if (body.active === false) {
      this.#remoteAccess = { active: false, provider: null, publicUrl: null, expiresAt: null };
      return { schemaVersion: SCHEMA_VERSION, ...this.#remoteAccess };
    }
    if (body.active !== true || body.provider !== "cloudflare") {
      throw new ServeDroidError("INVALID_ARGUMENT", "Remote access state is malformed.");
    }
    const publicUrl = typeof body.publicUrl === "string" ? body.publicUrl : "";
    let url: URL;
    try {
      url = new URL(publicUrl);
    } catch {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "Remote access requires an exact HTTPS origin.",
      );
    }
    if (url.protocol !== "https:" || url.origin !== publicUrl) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "Remote access requires an exact HTTPS origin.",
      );
    }
    const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt : "";
    const expiry = Date.parse(expiresAt);
    if (
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry > Date.now() + 2 * 60 * 60 * 1000
    ) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "Remote access expiry is outside the allowed window.",
      );
    }
    this.#remoteAccess = { active: true, provider: "cloudflare", publicUrl, expiresAt };
    return { schemaVersion: SCHEMA_VERSION, ...this.#remoteAccess };
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

  async #serveLogs(
    request: IncomingMessage,
    response: ServerResponse,
    since: string,
    packageName?: string,
  ): Promise<void> {
    const resumeFrom = sseResumeCursor(since, request.headers["last-event-id"]);
    const initial = await this.service.readLogs(resumeFrom, packageName);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    let unsubscribe: (() => void) | undefined;
    const write = (entry: Parameters<typeof writeSseLogFrame>[1]): boolean => {
      const writable = writeSseLogFrame(response, entry);
      if (!writable) {
        unsubscribe?.();
        unsubscribe = undefined;
      }
      return writable;
    };
    for (const entry of initial.entries) {
      if (!write(entry)) return;
    }
    unsubscribe = this.service.subscribeLogs(packageName, (entry) => void write(entry));
    request.once("close", () => {
      unsubscribe?.();
      unsubscribe = undefined;
    });
  }

  async #action(body: Record<string, unknown>): Promise<unknown> {
    const type = stringValue(body.type);
    const pointer = this.#video.control;
    let pointerTransport: "scrcpy" | "adb" | undefined;

    if (type === "tap") {
      const x = Number(body.x);
      const y = Number(body.y);
      if (pointer) {
        await pointer.tap(x, y);
        pointerTransport = "scrcpy";
      } else {
        await this.service.actions.tap(x, y);
        pointerTransport = "adb";
      }
    } else if (type === "swipe") {
      const x1 = Number(body.x1);
      const y1 = Number(body.y1);
      const x2 = Number(body.x2);
      const y2 = Number(body.y2);
      const durationMs = Number(body.durationMs ?? 300);
      if (pointer) {
        await pointer.swipe(x1, y1, x2, y2, durationMs);
        pointerTransport = "scrcpy";
      } else {
        await this.service.actions.swipe(x1, y1, x2, y2, durationMs);
        pointerTransport = "adb";
      }
    } else if (type === "gesture") {
      const gesture = body.gesture as Gesture;
      if (pointer) {
        await pointer.gesture(gesture);
        pointerTransport = "scrcpy";
      } else {
        await this.service.actions.gesture(gesture);
        pointerTransport = "adb";
      }
    } else if (type === "type") await this.service.actions.typeText(stringValue(body.text));
    else if (type === "key") await this.service.actions.key(body.key as never);
    else if (type === "rotate") await this.service.actions.rotate(body.orientation as never);
    else throw new ServeDroidError("INVALID_ARGUMENT", `Unsupported action '${type}'.`);

    const details: Record<string, unknown> = {};
    if (type === "tap") Object.assign(details, { x: Number(body.x), y: Number(body.y) });
    else if (type === "swipe")
      Object.assign(details, {
        x1: Number(body.x1),
        y1: Number(body.y1),
        x2: Number(body.x2),
        y2: Number(body.y2),
        durationMs: Number(body.durationMs ?? 300),
      });
    else if (type === "gesture")
      details.pointCount = Array.isArray((body.gesture as Gesture | undefined)?.points)
        ? (body.gesture as Gesture).points.length
        : 0;
    else if (type === "type") details.textLength = stringValue(body.text).length;
    else if (type === "key") details.key = stringValue(body.key);
    else if (type === "rotate") details.orientation = stringValue(body.orientation);
    if (pointerTransport) details.transport = pointerTransport;
    this.#recorder?.recordEvent("action", { action: type, ...details });
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
    this.#recorder?.recordEvent("app", {
      operation,
      packageName: packageName || null,
      activity: operation === "launch" ? stringValue(body.activity) || null : null,
    });
    return { schemaVersion: SCHEMA_VERSION, ok: true };
  }

  async #permission(body: Record<string, unknown>): Promise<unknown> {
    const output = await this.service.actions.permission(
      stringValue(body.operation) as never,
      stringValue(body.permission),
      stringValue(body.packageName),
    );
    this.#recorder?.recordEvent("permission", {
      operation: stringValue(body.operation),
      permission: stringValue(body.permission),
      packageName: stringValue(body.packageName),
    });
    return { schemaVersion: SCHEMA_VERSION, ok: true, output };
  }

  async #file(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const name = decodeUploadName(String(request.headers["x-file-name"] ?? ""));
    const directory = await mkdtemp(join(tmpdir(), "serve-droid-upload-"));
    const path = join(directory, name);
    try {
      await writeFile(path, await readBody(request, FILE_LIMIT), { flag: "wx", mode: 0o600 });
      const operation: FileOperation = name.toLocaleLowerCase().endsWith(".apk")
        ? "install"
        : "push";
      const execute = async (): Promise<unknown> => {
        if (operation === "install") {
          await this.service.actions.install(path);
          this.#recorder?.recordEvent("file", { operation: "install-apk" });
          return { schemaVersion: SCHEMA_VERSION, ok: true, operation };
        }
        const destination = await this.service.actions.push(path);
        this.#recorder?.recordEvent("file", { operation: "push" });
        return { schemaVersion: SCHEMA_VERSION, ok: true, operation, destination };
      };

      if (!acceptsFileProgressStream(request.headers.accept)) {
        json(response, 200, await execute());
        return;
      }

      startFileProgressStream(response);
      const activePhase = operation === "install" ? "installing" : "pushing";
      writeFileProgressFrame(
        response,
        "progress",
        fileProgressEvent(
          operation,
          activePhase,
          operation === "install" ? "Installing APK on Android." : "Pushing file to Android.",
        ),
      );
      try {
        const result = await execute();
        writeFileProgressFrame(
          response,
          "progress",
          fileProgressEvent(
            operation,
            "completed",
            operation === "install" ? "Install complete." : "Push complete.",
          ),
        );
        writeFileProgressFrame(response, "result", result);
      } catch (error) {
        const envelope = errorBody(error);
        writeFileProgressFrame(
          response,
          "progress",
          fileProgressEvent(operation, "failed", envelope.error.message),
        );
        writeFileProgressFrame(response, "error", envelope);
      } finally {
        response.end();
      }
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
        : url.pathname === "/api/v1/audio"
          ? this.#audioWebSocket
          : url.pathname === "/api/v1/control"
            ? this.#controlWebSocket
            : null;
    if (server === this.#videoWebSocket && server.clients.size >= this.#maxVideoClients) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
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
      const result = await this.#action(parseJsonObject(raw));
      socket.send(JSON.stringify(result));
    } catch (error) {
      socket.send(JSON.stringify(errorBody(error)));
    }
  }
}
