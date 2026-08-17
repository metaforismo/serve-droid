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
    "packages/server/src/decoded-frame.ts",
    '''function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {''',
    '''export function isDecodedFrameProviderHello(raw: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 && record.type === "decoded-frame-provider";
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {''',
    "provider hello parser",
)

replace_once(
    "packages/server/src/decoded-frame.ts",
    '''function isStartOfFrame(marker: number): boolean {''',
    '''function sameOptions(left: NormalizedOptions, right: NormalizedOptions): boolean {
  return (
    left.maxWidth === right.maxWidth &&
    left.quality === right.quality &&
    left.maxBytes === right.maxBytes &&
    left.timeoutMs === right.timeoutMs
  );
}

function isStartOfFrame(marker: number): boolean {''',
    "capture option equality",
)

replace_once(
    "packages/server/src/decoded-frame.ts",
    '''  public capture(
    options: DecodedFrameCaptureOptions = {},
  ): Promise<DecodedFrameCapture | null> {
    if (this.#pending) return this.#pending.promise;
    const normalized = normalizeOptions(options);
    const providers = new Set(''',
    '''  public capture(
    options: DecodedFrameCaptureOptions = {},
  ): Promise<DecodedFrameCapture | null> {
    const normalized = normalizeOptions(options);
    const active = this.#pending;
    if (active) {
      if (sameOptions(active, normalized)) return active.promise;
      return active.promise.then(() => this.capture(normalized));
    }
    const providers = new Set(''',
    "concurrent capture bounds",
)

replace_once(
    "packages/server/src/server.ts",
    '''  DecodedFrameBroker,
  jpegDimensions,
} from "./decoded-frame.js";''',
    '''  DecodedFrameBroker,
  isDecodedFrameProviderHello,
  jpegDimensions,
} from "./decoded-frame.js";''',
    "provider hello import",
)

replace_once(
    "packages/server/src/server.ts",
    '''    this.#videoWebSocket.on("connection", (socket) => {
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
    });''',
    '''    this.#videoWebSocket.on("connection", (socket) => {
      let unregister: (() => void) | undefined;
      socket.on("message", (message, binary) => {
        if (binary) return;
        const value = Array.isArray(message)
          ? Buffer.concat(message).toString("utf8")
          : Buffer.isBuffer(message)
            ? message.toString("utf8")
            : Buffer.from(message as ArrayBuffer).toString("utf8");
        if (!unregister && isDecodedFrameProviderHello(value)) {
          unregister = this.#decodedFrames.register(socket);
          return;
        }
        if (unregister) this.#decodedFrames.receive(socket, value);
      });
      socket.once("close", () => unregister?.());
    });''',
    "opt-in decoded frame provider",
)

replace_once(
    "packages/web/src/App.tsx",
    '''        socket.onopen = () => setStatus(`Streaming · ${backend}`);''',
    '''        socket.onopen = () => {
          setStatus(`Streaming · ${backend}`);
          socket?.send(JSON.stringify({ schemaVersion: 1, type: "decoded-frame-provider" }));
        };''',
    "browser provider hello",
)

path = Path("packages/server/test/decoded-frame.test.ts")
content = path.read_text(encoding="utf-8")
marker = '  it("allows another provider to win after one returns malformed data", async () => {'
extra = '''  it("serializes concurrent callers when their capture bounds differ", async () => {
    const broker = new DecodedFrameBroker();
    const provider = new FakeProvider();
    broker.register(provider);

    const first = broker.capture({ maxWidth: 1_080, quality: 75, timeoutMs: 250 });
    const firstRequest = request(provider);
    const second = broker.capture({ maxWidth: 320, quality: 60, timeoutMs: 250 });
    expect(second).not.toBe(first);
    expect(provider.sent).toHaveLength(1);

    broker.receive(provider, frameResponse(firstRequest.id));
    await expect(first).resolves.toMatchObject({ width: 3, height: 2 });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    expect(provider.sent).toHaveLength(2);
    const secondRequest = request(provider);
    expect(secondRequest).toMatchObject({ maxWidth: 320, quality: 60 });
    broker.receive(provider, frameResponse(secondRequest.id));
    await expect(second).resolves.toMatchObject({ width: 3, height: 2 });
  });

'''
if 'it("serializes concurrent callers when their capture bounds differ"' not in content:
    if marker not in content:
        raise SystemExit("concurrent bounds test marker was not found")
    path.write_text(content.replace(marker, extra + marker, 1), encoding="utf-8")

replace_once(
    "packages/server/test/decoded-frame-routing.test.ts",
    '''async function connectVideo(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url.replace(/^http/u, "ws") + "/api/v1/video", [
    "serve-droid",
    "token.test-token",
  ]);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}''',
    '''async function connectVideo(url: string, decodedFrameProvider = true): Promise<WebSocket> {
  const socket = new WebSocket(url.replace(/^http/u, "ws") + "/api/v1/video", [
    "serve-droid",
    "token.test-token",
  ]);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  if (decodedFrameProvider) {
    socket.send(JSON.stringify({ schemaVersion: 1, type: "decoded-frame-provider" }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return socket;
}''',
    "routing provider hello",
)

path = Path("packages/server/test/decoded-frame-routing.test.ts")
content = path.read_text(encoding="utf-8")
marker = '  it("uses ADB immediately when no decoded-frame provider is connected", async () => {'
extra = '''  it("keeps legacy video-only clients on a binary-only output contract", async () => {
    const service = new ScreenshotService(new FakeAdb(), device);
    const server = new ServeDroidServer(service, {
      token: "test-token",
      videoSource: new FakeVideo(),
    });
    servers.push(server);
    const session = await server.start();
    const socket = await connectVideo(session.url, false);
    let textMessages = 0;
    socket.on("message", (_data, binary) => {
      if (!binary) textMessages += 1;
    });

    const response = await screenshotRequest(session.url);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-serve-droid-screenshot-source")).toBe("device");
    expect(service.screenshotCalls).toBe(1);
    expect(textMessages).toBe(0);
  });

'''
if 'it("keeps legacy video-only clients on a binary-only output contract"' not in content:
    if marker not in content:
        raise SystemExit("legacy video test marker was not found")
    path.write_text(content.replace(marker, extra + marker, 1), encoding="utf-8")

replace_once(
    "docs/screenshots.md",
    '''2. If one or more authenticated video WebSocket clients are connected, the server sends a small
   `capture-decoded-frame` request over that existing socket.''',
    '''2. An authenticated browser explicitly advertises `decoded-frame-provider` on its existing video
   WebSocket. Only opted-in sockets may receive a small `capture-decoded-frame` request; legacy video
   clients continue to receive binary H.264 only.''',
    "screenshot capture order",
)

replace_once(
    "docs/screenshots.md",
    '''same bearer-authenticated video WebSocket as the H.264 stream. No token is added to a query string and
no new listener is opened.''',
    '''same bearer-authenticated video WebSocket as the H.264 stream, after the browser explicitly opts in.
No token is added to a query string and no new listener is opened.''',
    "screenshot security handshake",
)

replace_once(
    "docs/screenshots.md",
    '''connected provider may still succeed. Concurrent screenshot callers share one in-flight capture.''',
    '''connected provider may still succeed. Concurrent callers with identical bounds share one in-flight
capture; callers with different width, quality, byte, or timeout bounds are serialized so one caller
can never inherit a looser request.''',
    "screenshot concurrency contract",
)

replace_once(
    "docs/protocol.md",
    '''- `GET /api/v1/video` upgrades to a binary H.264 WebSocket.''',
    '''- `GET /api/v1/video` upgrades to a binary H.264 WebSocket. Clients that explicitly opt into the
  decoded-frame extension may additionally exchange the bounded JSON messages described below.''',
    "video protocol bullet",
)

replace_once(
    "docs/protocol.md",
    '''Credentials never appear in URL query parameters.

Uploads use `application/octet-stream`''',
    '''Credentials never appear in URL query parameters.

Decoded-frame screenshots are an opt-in extension to the video socket. A capable browser sends
`{"schemaVersion":1,"type":"decoded-frame-provider"}` after the socket opens. Only a socket that
sent that declaration is eligible to receive a `capture-decoded-frame` text request or return a
`decoded-frame` response. Video clients that do not opt in preserve the original binary-only H.264
output contract.

Uploads use `application/octet-stream`''',
    "decoded frame protocol extension",
)
