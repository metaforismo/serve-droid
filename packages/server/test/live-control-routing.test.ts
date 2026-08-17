import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  AndroidService,
  type AdbRunner,
  type DeviceSummary,
  type Gesture,
  type RunResult,
} from "../../core/src/index.js";
import type { DevicePointerControl } from "../src/control.js";
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
  public readonly calls: string[][] = [];

  public async run(args: readonly string[]): Promise<RunResult> {
    this.calls.push([...args]);
    const key = args.join(" ");
    if (key === "shell wm size") return ok("Physical size: 1080x1920\n");
    if (key === "shell wm density") return ok("Physical density: 420\n");
    if (key === "shell dumpsys input") return ok("SurfaceOrientation: 0\n");
    return ok("");
  }

  public async capture(): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  public spawn(): never {
    return new FakeProcess() as never;
  }
}

class FakePointerControl implements DevicePointerControl {
  public readonly gestures: Gesture[] = [];

  public async tap(_x: number, _y: number): Promise<void> {}
  public async swipe(
    _x1: number,
    _y1: number,
    _x2: number,
    _y2: number,
    _durationMs?: number,
  ): Promise<void> {}
  public async gesture(gesture: Gesture): Promise<void> {
    this.gestures.push(gesture);
  }
}

class FakeVideo extends EventEmitter<VideoSourceEvents> implements VideoSource {
  public constructor(public readonly control: DevicePointerControl | undefined) {
    super();
  }

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
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

async function controlSocket(server: ServeDroidServer): Promise<WebSocket> {
  const session = await server.start();
  const socket = new WebSocket(session.url.replace(/^http/u, "ws") + "/api/v1/control", [
    "serve-droid",
    "token.test-token",
  ]);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function response(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    socket.once("error", reject);
  });
}

const begin = {
  type: "gesture",
  gesture: {
    points: [{ x: 0.25, y: 0.75 }],
    stream: { id: "0123456789abcdef", phase: "begin" },
  },
};

describe("live pointer control routing", () => {
  it("forwards a stream phase to the active scrcpy pointer controller", async () => {
    const adb = new FakeAdb();
    const pointer = new FakePointerControl();
    const server = new ServeDroidServer(new AndroidService(adb, device), {
      token: "test-token",
      videoSource: new FakeVideo(pointer),
    });
    servers.push(server);
    const socket = await controlSocket(server);
    const next = response(socket);

    socket.send(JSON.stringify(begin));

    await expect(next).resolves.toMatchObject({ schemaVersion: 1, ok: true });
    expect(pointer.gestures).toEqual([begin.gesture]);
    expect(adb.calls.some((call) => call.includes("input"))).toBe(false);
    socket.close();
  });

  it("marks the pre-injection ADB boundary as safe for browser fallback", async () => {
    const adb = new FakeAdb();
    const server = new ServeDroidServer(new AndroidService(adb, device), {
      token: "test-token",
      videoSource: new FakeVideo(undefined),
    });
    servers.push(server);
    const socket = await controlSocket(server);
    const next = response(socket);

    socket.send(JSON.stringify(begin));

    await expect(next).resolves.toMatchObject({
      error: {
        code: "TRANSPORT_FAILED",
        details: { safeToFallback: true, phase: "begin" },
      },
    });
    expect(adb.calls.some((call) => call.includes("input"))).toBe(false);
    socket.close();
  });
});
