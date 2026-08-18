import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  AndroidService,
  type AdbRunner,
  type DeviceSummary,
  type RunResult,
} from "../../core/src/index.js";
import {
  DECODED_FRAME_MAX_PAYLOAD,
  DecodedFrameBroker,
  type DecodedFrameProvider,
} from "../src/decoded-frame.js";
import { ServeDroidServer } from "../src/server.js";
import type { VideoSource, VideoSourceEvents } from "../src/video.js";

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
  public async run(args: readonly string[]): Promise<RunResult> {
    const command = args.join(" ");
    if (command === "shell wm size") return ok("Physical size: 1080x1920\n");
    if (command === "shell wm density") return ok("Physical density: 420\n");
    if (command === "shell dumpsys input") return ok("SurfaceOrientation: 0\n");
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

class Provider implements DecodedFrameProvider {
  public readyState = WebSocket.OPEN;
  public bufferedAmount = 0;
  public readonly sent: string[] = [];

  public send(data: string): void {
    this.sent.push(data);
  }
}

function ok(stdout: string): RunResult {
  return { stdout, stderr: "", exitCode: 0 };
}

const device: DeviceSummary = {
  serial: "transport-bounds",
  state: "device",
  kind: "physical",
  model: "Transport Bounds",
  product: "fixture",
  manufacturer: "Test",
  apiLevel: 35,
  abi: "arm64-v8a",
};

const servers: ServeDroidServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function server(options: { maxVideoClients?: number } = {}): Promise<string> {
  const current = new ServeDroidServer(new AndroidService(new FakeAdb(), device), {
    token: "test-token",
    videoSource: new FakeVideo(),
    ...options,
  });
  servers.push(current);
  return (await current.start()).url;
}

async function connect(url: string, path: string): Promise<WebSocket> {
  const socket = new WebSocket(url.replace(/^http/u, "ws") + path, [
    "serve-droid",
    "token.test-token",
  ]);
  sockets.push(socket);
  await once(socket, "open");
  return socket;
}

async function closeCodeAfterSend(socket: WebSocket, payload: Buffer): Promise<number> {
  const closed = once(socket, "close") as Promise<[number, Buffer]>;
  socket.send(payload);
  const [code] = await closed;
  return code;
}

describe("decoded-frame provider bounds", () => {
  it("does not enqueue capture work onto a provider that is already backpressured", async () => {
    const broker = new DecodedFrameBroker();
    const provider = new Provider();
    provider.bufferedAmount = 256 * 1024;
    broker.register(provider);

    await expect(broker.capture()).resolves.toBeNull();
    expect(provider.sent).toEqual([]);
  });

  it("ignores malformed provider JSON without consuming a later valid response", async () => {
    const broker = new DecodedFrameBroker();
    const provider = new Provider();
    broker.register(provider);
    const pending = broker.capture({ timeoutMs: 250 });
    const request = JSON.parse(provider.sent[0]!) as { id: string };

    expect(broker.receive(provider, "{not-json")).toBe(false);
    expect(
      broker.receive(
        provider,
        JSON.stringify({
          schemaVersion: 1,
          type: "decoded-frame-error",
          id: request.id,
          code: "FRAME_NOT_READY",
        }),
      ),
    ).toBe(true);
    await expect(pending).resolves.toBeNull();
  });
});

describe("WebSocket payload and client bounds", () => {
  it("closes an audio client that exceeds its 256 KiB inbound payload limit", async () => {
    const url = await server();
    const socket = await connect(url, "/api/v1/audio");

    await expect(closeCodeAfterSend(socket, Buffer.alloc(256 * 1024 + 1))).resolves.toBe(1009);
  });

  it("closes a video client that exceeds the decoded-frame payload limit", async () => {
    const url = await server();
    const socket = await connect(url, "/api/v1/video");

    await expect(closeCodeAfterSend(socket, Buffer.alloc(DECODED_FRAME_MAX_PAYLOAD + 1))).resolves.toBe(
      1009,
    );
  });

  it("rejects a video connection before upgrade when the configured client limit is full", async () => {
    const url = await server({ maxVideoClients: 1 });
    await connect(url, "/api/v1/video");
    const second = new WebSocket(url.replace(/^http/u, "ws") + "/api/v1/video", [
      "serve-droid",
      "token.test-token",
    ]);
    sockets.push(second);

    const status = await new Promise<number>((resolve, reject) => {
      second.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      second.once("open", () => reject(new Error("second video client unexpectedly connected")));
      second.once("error", () => undefined);
    });
    expect(status).toBe(503);
  });
});
