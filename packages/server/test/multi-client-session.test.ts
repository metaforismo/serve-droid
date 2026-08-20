import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  AndroidService,
  type AdbRunner,
  type DeviceSummary,
  type RunResult,
} from "../../core/src/index.js";
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
  public calls: string[][] = [];

  public async run(args: readonly string[]): Promise<RunResult> {
    this.calls.push([...args]);
    const key = args.join(" ");
    if (key === "shell wm size") return ok("Physical size: 1080x1920\n");
    if (key === "shell wm density") return ok("Physical density: 420\n");
    if (key === "shell dumpsys input") return ok("SurfaceOrientation: 0\n");
    if (key === "devices -l") {
      return ok("List of devices attached\nserial device model:Pixel_9 transport_id:1\n");
    }
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
  public starts = 0;
  public stops = 0;

  public async start(): Promise<void> {
    this.starts += 1;
  }

  public async stop(): Promise<void> {
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

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function wsUrl(sessionUrl: string, path: string): string {
  return `${sessionUrl.replace(/^http/u, "ws")}${path}`;
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, ["serve-droid", "token.shared-token"]);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function nextMessage(socket: WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    const onMessage = (data: RawData) => {
      socket.off("error", onError);
      resolve(toBuffer(data));
    };
    socket.once("error", onError);
    socket.once("message", onMessage);
  });
}

function rejectedStatus(url: string): Promise<number> {
  const socket = new WebSocket(url, ["serve-droid", "token.shared-token"]);
  return new Promise((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      resolve(status);
    });
    socket.once("open", () => reject(new Error("A third video client unexpectedly connected.")));
    socket.once("error", () => undefined);
  });
}

describe("shared session multi-client transport", () => {
  it("fans one video source out to two clients and accepts bounded control from both", async () => {
    const adb = new FakeAdb();
    const video = new FakeVideo();
    const server = new ServeDroidServer(new AndroidService(adb, device), {
      token: "shared-token",
      videoSource: video,
    });
    servers.push(server);
    const session = await server.start();

    const videoEndpoint = wsUrl(session.url, "/api/v1/video");
    const controlEndpoint = wsUrl(session.url, "/api/v1/control");
    const [videoOne, videoTwo, controlOne, controlTwo] = await Promise.all([
      connect(videoEndpoint),
      connect(videoEndpoint),
      connect(controlEndpoint),
      connect(controlEndpoint),
    ]);

    expect(video.starts).toBe(1);

    const packet = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x28]);
    const firstPacket = nextMessage(videoOne);
    const secondPacket = nextMessage(videoTwo);
    video.emit("data", packet);

    await expect(firstPacket).resolves.toEqual(packet);
    await expect(secondPacket).resolves.toEqual(packet);
    await expect(rejectedStatus(videoEndpoint)).resolves.toBe(503);

    const firstReply = nextMessage(controlOne);
    const secondReply = nextMessage(controlTwo);
    controlOne.send(JSON.stringify({ type: "key", key: "home" }));
    controlTwo.send(JSON.stringify({ type: "key", key: "back" }));

    await expect(firstReply.then((value) => JSON.parse(value.toString("utf8")))).resolves.toEqual({
      schemaVersion: 1,
      ok: true,
    });
    await expect(secondReply.then((value) => JSON.parse(value.toString("utf8")))).resolves.toEqual({
      schemaVersion: 1,
      ok: true,
    });

    const commands = adb.calls.map((call) => call.join(" "));
    expect(commands).toContain("shell input keyevent KEYCODE_HOME");
    expect(commands).toContain("shell input keyevent KEYCODE_BACK");

    for (const socket of [videoOne, videoTwo, controlOne, controlTwo]) socket.close();
  });
});
