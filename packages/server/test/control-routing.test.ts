import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  AndroidService,
  ServeDroidError,
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
  public readonly taps: Array<[number, number]> = [];
  public readonly swipes: Array<[number, number, number, number, number | undefined]> = [];
  public readonly gestures: Gesture[] = [];
  public failure: Error | undefined;

  public async tap(x: number, y: number): Promise<void> {
    if (this.failure) throw this.failure;
    this.taps.push([x, y]);
  }

  public async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number,
  ): Promise<void> {
    if (this.failure) throw this.failure;
    this.swipes.push([x1, y1, x2, y2, durationMs]);
  }

  public async gesture(gesture: Gesture): Promise<void> {
    if (this.failure) throw this.failure;
    this.gestures.push(gesture);
  }
}

class FakeVideo extends EventEmitter<VideoSourceEvents> implements VideoSource {
  public constructor(public readonly control?: DevicePointerControl) {
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

async function postAction(
  server: ServeDroidServer,
  body: Record<string, unknown>,
): Promise<Response> {
  const session = await server.start();
  return fetch(`${session.url}/api/v1/actions`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("pointer transport routing", () => {
  it("routes tap, swipe, and gesture through the active scrcpy control", async () => {
    const adb = new FakeAdb();
    const control = new FakePointerControl();
    const server = new ServeDroidServer(new AndroidService(adb, device), {
      token: "test-token",
      videoSource: new FakeVideo(control),
    });
    servers.push(server);

    expect((await postAction(server, { type: "tap", x: 0.25, y: 0.75 })).status).toBe(200);
    expect(
      (
        await postAction(server, {
          type: "swipe",
          x1: 0.2,
          y1: 0.8,
          x2: 0.2,
          y2: 0.2,
          durationMs: 180,
        })
      ).status,
    ).toBe(200);
    const gesture = {
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.5, durationMs: 90 },
        { x: 0.9, y: 0.2, durationMs: 110 },
      ],
    };
    expect((await postAction(server, { type: "gesture", gesture })).status).toBe(200);

    expect(control.taps).toEqual([[0.25, 0.75]]);
    expect(control.swipes).toEqual([[0.2, 0.8, 0.2, 0.2, 180]]);
    expect(control.gestures).toEqual([gesture]);
    expect(adb.calls.some((call) => call.includes("input"))).toBe(false);
  });

  it("uses the existing bounded ADB action path when scrcpy control is unavailable", async () => {
    const adb = new FakeAdb();
    const server = new ServeDroidServer(new AndroidService(adb, device), {
      token: "test-token",
      videoSource: new FakeVideo(),
    });
    servers.push(server);

    expect((await postAction(server, { type: "tap", x: 0.5, y: 0.25 })).status).toBe(200);
    expect(adb.calls).toContainEqual(["shell", "input", "tap", "540", "480"]);
  });

  it("does not replay a failed scrcpy pointer action through ADB", async () => {
    const adb = new FakeAdb();
    const control = new FakePointerControl();
    control.failure = new ServeDroidError("TRANSPORT_FAILED", "scrcpy control failed");
    const server = new ServeDroidServer(new AndroidService(adb, device), {
      token: "test-token",
      videoSource: new FakeVideo(control),
    });
    servers.push(server);

    const response = await postAction(server, { type: "tap", x: 0.5, y: 0.5 });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "TRANSPORT_FAILED", message: "scrcpy control failed" },
    });
    expect(adb.calls.some((call) => call.includes("input"))).toBe(false);
  });
});
