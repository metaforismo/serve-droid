import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  AndroidService,
  type AdbRunner,
  type DeviceSummary,
  type RunResult,
} from "../../core/src/index.js";
import { assertPortAvailable } from "../src/listen.js";
import { canSendAudio, encodeAudioPacket, ServeDroidServer } from "../src/server.js";
import {
  RestartingVideoSource,
  SCRCPY_SERVER_SHA256,
  type VideoSource,
  type VideoSourceEvents,
} from "../src/video.js";

class FakeProcess extends EventEmitter {
  public stdin = new PassThrough();
  public stdout = new PassThrough();
  public stderr = new PassThrough();
  public kill(): boolean {
    this.emit("close", 0);
    return true;
  }
}

class FakeAdb implements AdbRunner {
  public calls: string[][] = [];
  public async run(args: readonly string[]): Promise<RunResult> {
    this.calls.push([...args]);
    const key = args.join(" ");
    if (key === "shell wm size") return ok("Physical size: 1080x1920\n");
    if (key === "shell wm density") return ok("Physical density: 420\n");
    if (key === "shell dumpsys input") return ok("SurfaceOrientation: 0\n");
    if (key === "devices -l")
      return ok("List of devices attached\nserial device model:Pixel_9 transport_id:1\n");
    if (key.includes("ro.build.version.sdk")) return ok("35\n");
    if (key.includes("ro.product.manufacturer")) return ok("Google\n");
    if (key.includes("ro.product.cpu.abi")) return ok("arm64-v8a\n");
    if (key.includes("ro.kernel.qemu")) return ok("0\n");
    return ok("");
  }
  public async capture(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  public spawn(): never {
    return new FakeProcess() as never;
  }
}

class FakeVideo extends EventEmitter<VideoSourceEvents> implements VideoSource {
  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
}

class ControlledVideo extends FakeVideo {
  public starts = 0;
  public stops = 0;

  public constructor(private readonly startError?: Error) {
    super();
  }

  public override async start(): Promise<void> {
    this.starts += 1;
    if (this.startError) throw this.startError;
  }

  public override async stop(): Promise<void> {
    this.stops += 1;
  }
}

function ok(stdout: string): RunResult {
  return { stdout, stderr: "", exitCode: 0 };
}

const device: DeviceSummary = {
  serial: "serial",
  state: "device",
  kind: "physical",
  model: "Pixel 9",
  product: "tokay",
  manufacturer: "Google",
  apiLevel: 35,
  abi: "arm64-v8a",
};

const servers: ServeDroidServer[] = [];
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("bounded video recovery", () => {
  it("restarts once after duplicate runtime errors and then surfaces a typed terminal error", async () => {
    const first = new ControlledVideo();
    const second = new ControlledVideo();
    const sources = [first, second];
    const video = new RestartingVideoSource(() => sources.shift()!);
    const restarts: Array<{ attempt: number; maxAttempts: number }> = [];
    video.on("restart", (event) => restarts.push(event));
    const packets: Buffer[] = [];
    video.on("data", (packet) => packets.push(packet));
    await video.start();

    first.emit("error", new Error("video stream failed"));
    first.emit("error", new Error("duplicate output failure"));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    expect(first.stops).toBe(1);
    expect(second.starts).toBe(1);
    expect(restarts).toEqual([{ attempt: 1, maxAttempts: 1 }]);
    second.emit("data", Buffer.from([1, 2, 3]));
    expect(packets).toEqual([Buffer.from([1, 2, 3])]);

    const terminal = new Promise<Error>((resolvePromise) => video.once("error", resolvePromise));
    second.emit("error", new Error("replacement failed"));
    await expect(terminal).resolves.toMatchObject({
      code: "TRANSPORT_FAILED",
      details: { restartAttempts: 1, maxRestarts: 1, cause: "replacement failed" },
    });
    expect(sources).toHaveLength(0);
    await video.stop();
  });

  it("uses the same single restart budget when initial startup fails", async () => {
    const first = new ControlledVideo(new Error("initial start failed"));
    const second = new ControlledVideo();
    const sources = [first, second];
    const video = new RestartingVideoSource(() => sources.shift()!);
    const restarts: number[] = [];
    video.on("restart", ({ attempt }) => restarts.push(attempt));

    await video.start();

    expect(first.stops).toBe(1);
    expect(second.starts).toBe(1);
    expect(restarts).toEqual([1]);
    await video.stop();
  });
});

describe("authenticated HTTP server", () => {
  it("keeps health public and protects device data and mutations", async () => {
    const adb = new FakeAdb();
    const server = new ServeDroidServer(new AndroidService(adb, device), {
      token: "test-token",
      videoSource: new FakeVideo(),
    });
    servers.push(server);
    const session = await server.start();

    expect((await fetch(`${session.url}/api/v1/health`)).status).toBe(200);
    expect((await fetch(`${session.url}/api/v1/session`)).status).toBe(401);

    const authenticated = await fetch(`${session.url}/api/v1/session`, {
      headers: { authorization: "Bearer test-token" },
    });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).not.toHaveProperty("token", "test-token");

    const unauthorizedAction = await fetch(`${session.url}/api/v1/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "tap", x: 0.5, y: 0.5 }),
    });
    expect(unauthorizedAction.status).toBe(401);
    expect(adb.calls.some((call) => call.includes("tap"))).toBe(false);
  });

  it("authenticates, validates, and revokes visible remote-access state", async () => {
    const server = new ServeDroidServer(new AndroidService(new FakeAdb(), device), {
      token: "test-token",
      videoSource: new FakeVideo(),
    });
    servers.push(server);
    const session = await server.start();
    const unauthorized = await fetch(`${session.url}/api/v1/remote-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    expect(unauthorized.status).toBe(401);
    const headers = {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    };
    const activated = await fetch(`${session.url}/api/v1/remote-access`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        active: true,
        provider: "cloudflare",
        publicUrl: "https://android.example.test",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({ active: true, provider: "cloudflare" });
    const malformed = await fetch(`${session.url}/api/v1/remote-access`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        active: true,
        provider: "cloudflare",
        publicUrl: "https://android.example.test/?token=bad",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    expect(malformed.status).toBe(400);
    const invalidUrl = await fetch(`${session.url}/api/v1/remote-access`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        active: true,
        provider: "cloudflare",
        publicUrl: "not-a-url",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    expect(invalidUrl.status).toBe(400);
    const revoked = await fetch(`${session.url}/api/v1/remote-access`, {
      method: "POST",
      headers,
      body: JSON.stringify({ active: false }),
    });
    expect(await revoked.json()).toMatchObject({ active: false, publicUrl: null });
  });

  it("records action metadata without typed text, tokens, or Logcat", async () => {
    const root = await mkdtemp(join(tmpdir(), "serve-droid-server-recording-test-"));
    temporaryDirectories.push(root);
    const server = new ServeDroidServer(new AndroidService(new FakeAdb(), device), {
      token: "token-that-must-not-be-recorded",
      videoSource: new FakeVideo(),
      recording: { directory: root, maxBytes: 1024 * 1024, maxDurationMs: 60_000 },
    });
    servers.push(server);
    const session = await server.start();
    const response = await fetch(`${session.url}/api/v1/actions`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-that-must-not-be-recorded",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "type", text: "user-secret-text" }),
    });
    expect(response.status).toBe(200);
    const directory = server.recording?.directory;
    expect(directory).toBeTruthy();
    await server.stop();
    const events = await readFile(join(directory!, "events.jsonl"), "utf8");
    expect(events).toContain('"textLength":16');
    expect(events).not.toContain("user-secret-text");
    expect(events).not.toContain("token-that-must-not-be-recorded");
    expect(events).not.toContain("Logcat");
  });

  it("authenticates audio sockets and relays state plus timestamped packets", async () => {
    const source = new FakeVideo();
    const server = new ServeDroidServer(new AndroidService(new FakeAdb(), device), {
      token: "test-token",
      videoSource: source,
      audio: true,
    });
    servers.push(server);
    const session = await server.start();
    const socket = new WebSocket(session.url.replace(/^http/u, "ws") + "/api/v1/audio", [
      "serve-droid",
      "token.test-token",
    ]);
    const messages: Array<string | Buffer> = [];
    socket.on("message", (data, binary) =>
      messages.push(binary ? Buffer.from(data as Buffer) : String(data)),
    );
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    source.emit("audioState", { enabled: true, available: true, codec: "opus" });
    source.emit("audioData", { data: Buffer.from([1, 2, 3]), pts: 42n });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    expect(
      messages.some(
        (message) => typeof message === "string" && message.includes('"available":true'),
      ),
    ).toBe(true);
    const packet = messages.find(Buffer.isBuffer);
    expect(packet?.readBigInt64BE(0)).toBe(42n);
    expect(packet?.subarray(8)).toEqual(Buffer.from([1, 2, 3]));
    socket.close();
  });

  it("allows framing only for an explicit exact loopback grid origin", async () => {
    const service = new AndroidService(new FakeAdb(), device);
    expect(
      () =>
        new ServeDroidServer(service, {
          videoSource: new FakeVideo(),
          frameAncestor: "https://example.com",
        }),
    ).toThrow(/127\.0\.0\.1/u);

    const server = new ServeDroidServer(service, {
      videoSource: new FakeVideo(),
      frameAncestor: "http://127.0.0.1:9001",
    });
    servers.push(server);
    const session = await server.start();
    const response = await fetch(session.url);
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors http://127.0.0.1:9001",
    );
  });

  it("diagnoses an occupied fixed port before device startup", async () => {
    const blocker = createServer();
    await new Promise<void>((resolvePromise, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolvePromise);
    });
    const port = (blocker.address() as AddressInfo).port;
    try {
      await expect(assertPortAvailable("127.0.0.1", port)).rejects.toMatchObject({
        code: "PORT_IN_USE",
        details: { host: "127.0.0.1", port },
      });
      const adb = new FakeAdb();
      const server = new ServeDroidServer(new AndroidService(adb, device), {
        port,
        videoSource: new FakeVideo(),
      });
      await expect(server.start()).rejects.toMatchObject({ code: "PORT_IN_USE" });
      expect(adb.calls).toEqual([]);
    } finally {
      await new Promise<void>((resolvePromise, reject) =>
        blocker.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  });
});

describe("audio wire format", () => {
  it("prefixes each packet with a signed 64-bit presentation timestamp", () => {
    const packet = encodeAudioPacket(Buffer.from([9, 8]), 123n);
    expect(packet.readBigInt64BE(0)).toBe(123n);
    expect(packet.subarray(8)).toEqual(Buffer.from([9, 8]));
  });

  it("bounds socket backpressure", () => {
    expect(canSendAudio(0)).toBe(true);
    expect(canSendAudio(512 * 1024 - 1)).toBe(true);
    expect(canSendAudio(512 * 1024)).toBe(false);
    expect(canSendAudio(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("vendored scrcpy server", () => {
  it("matches the recorded checksum", async () => {
    const data = await readFile(resolve(import.meta.dirname, "../vendor/scrcpy-server-v3.3.3"));
    expect(createHash("sha256").update(data).digest("hex")).toBe(SCRCPY_SERVER_SHA256);
  });
});
