from pathlib import Path


def replace_once(path_name: str, old: str, new: str, label: str) -> None:
    path = Path(path_name)
    content = path.read_text(encoding="utf-8")
    if new in content:
        return
    if old not in content:
        raise SystemExit(f"{label} marker was not found in {path_name}")
    path.write_text(content.replace(old, new, 1), encoding="utf-8")


replace_once(
    "packages/server/src/index.ts",
    'export * from "./control.js";\nexport * from "./tunnel.js";\n',
    'export * from "./control.js";\nexport * from "./decoded-frame.js";\nexport * from "./tunnel.js";\n',
    "server export",
)

replace_once(
    "packages/server/src/server.ts",
    'import { listenHttpServer } from "./listen.js";\n',
    '''import { listenHttpServer } from "./listen.js";
import {
  DECODED_FRAME_DEFAULT_QUALITY,
  DECODED_FRAME_DEFAULT_WIDTH,
  DECODED_FRAME_MAX_PAYLOAD,
  DecodedFrameBroker,
  jpegDimensions,
} from "./decoded-frame.js";
''',
    "decoded frame import",
)

replace_once(
    "packages/server/src/server.ts",
    '''export interface ServerOptions {
  host?: string;
  port?: number;
  token?: string;
  webRoot?: string;
  videoSource?: VideoSource;
  recording?: Omit<RecordingOptions, "serial">;
  audio?: boolean;
  frameAncestor?: string;
  maxVideoClients?: number;
}
''',
    '''export interface ServerOptions {
  host?: string;
  port?: number;
  token?: string;
  webRoot?: string;
  videoSource?: VideoSource;
  recording?: Omit<RecordingOptions, "serial">;
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
''',
    "agent screenshot interfaces",
)

replace_once(
    "packages/server/src/server.ts",
    '  readonly #video: VideoSource;\n  readonly #token: string;\n',
    '  readonly #video: VideoSource;\n  readonly #decodedFrames = new DecodedFrameBroker();\n  readonly #token: string;\n',
    "decoded frame field",
)

replace_once(
    "packages/server/src/server.ts",
    '    this.#videoWebSocket = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });',
    '    this.#videoWebSocket = new WebSocketServer({\n      noServer: true,\n      maxPayload: DECODED_FRAME_MAX_PAYLOAD,\n    });',
    "video payload bound",
)

replace_once(
    "packages/server/src/server.ts",
    '''    this.#http.on("upgrade", (request, socket, head) => this.#upgrade(request, socket, head));
    this.#controlWebSocket.on("connection", (socket) => {''',
    '''    this.#http.on("upgrade", (request, socket, head) => this.#upgrade(request, socket, head));
    this.#videoWebSocket.on("connection", (socket) => {
      const unregister = this.#decodedFrames.register(socket);
      socket.on("message", (message, binary) => {
        if (binary) return;
        const value = Array.isArray(message)
          ? Buffer.concat(message).toString("utf8")
          : Buffer.isBuffer(message)
            ? message.toString("utf8")
            : Buffer.from(message as ArrayBuffer).toString("utf8");
        this.#decodedFrames.receive(socket, value);
      });
      socket.once("close", unregister);
    });
    this.#controlWebSocket.on("connection", (socket) => {''',
    "video response handler",
)

replace_once(
    "packages/server/src/server.ts",
    '''  public async start(): Promise<SessionInfo> {''',
    '''  public async captureAgentScreenshot(
    options: AgentScreenshotOptions = {},
  ): Promise<AgentScreenshot> {
    const width = options.width ?? DECODED_FRAME_DEFAULT_WIDTH;
    const quality = options.quality ?? DECODED_FRAME_DEFAULT_QUALITY;
    if (!Number.isInteger(width) || width < 1 || width > 2_048) {
      throw new ServeDroidError("INVALID_ARGUMENT", "Screenshot width must be between 1 and 2048.");
    }
    if (!Number.isInteger(quality) || quality < 25 || quality > 95) {
      throw new ServeDroidError("INVALID_ARGUMENT", "Screenshot quality must be between 25 and 95.");
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

  public async start(): Promise<SessionInfo> {''',
    "agent screenshot method",
)

replace_once(
    "packages/server/src/server.ts",
    '''    this.#stopping = true;
    await this.#video.stop();''',
    '''    this.#stopping = true;
    this.#decodedFrames.close();
    await this.#video.stop();''',
    "broker shutdown",
)

replace_once(
    "packages/server/src/server.ts",
    '''      } else if (url.pathname === "/api/v1/screenshot" && request.method === "GET") {
        const jpeg = await this.service.screenshot();
        response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
        response.end(jpeg);''',
    '''      } else if (url.pathname === "/api/v1/screenshot" && request.method === "GET") {
        const capture = await this.captureAgentScreenshot();
        const headers: Record<string, string> = {
          "content-type": capture.mimeType,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-serve-droid-screenshot-source": capture.source,
          "x-serve-droid-screenshot-captured-at": capture.capturedAt,
        };
        if (capture.width !== null) headers["x-serve-droid-screenshot-width"] = String(capture.width);
        if (capture.height !== null)
          headers["x-serve-droid-screenshot-height"] = String(capture.height);
        response.writeHead(200, headers);
        response.end(capture.data);''',
    "HTTP screenshot route",
)

replace_once(
    "packages/web/src/App.tsx",
    'import { createH264CanvasPlayer, type CanvasPlayer } from "./video.js";\n',
    'import { createH264CanvasPlayer, type CanvasPlayer } from "./video.js";\nimport { handleDecodedFrameRequest } from "./decoded-frame.js";\n',
    "web decoded frame import",
)

replace_once(
    "packages/web/src/App.tsx",
    '        socket.onmessage = (event) => player?.push(event.data as ArrayBuffer);',
    '''        socket.onmessage = (event) => {
          if (typeof event.data === "string") {
            void handleDecodedFrameRequest(event.data, (message) => {
              if (socket?.readyState === WebSocket.OPEN) socket.send(message);
            }).catch((reason: unknown) =>
              setError(reason instanceof Error ? reason.message : String(reason)),
            );
            return;
          }
          player?.push(event.data as ArrayBuffer);
        };''',
    "web video message routing",
)
