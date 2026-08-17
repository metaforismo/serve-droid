import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  AndroidService,
  type AdbRunner,
  type DeviceSummary,
  type RunResult,
} from "@serve-droid/core";
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
    const key = args.join(" ");
    if (key === "shell wm size") return ok("Physical size: 1080x1920\n");
    if (key === "shell wm density") return ok("Physical density: 420\n");
    if (key === "shell dumpsys input") return ok("SurfaceOrientation: 0\n");
    return ok("");
  }

  public async capture(): Promise<Buffer> {
    throw new Error("direct ADB capture must be provided by the test service");
  }

  public spawn(): never {
    return new FakeProcess() as never;
  }
}

class FakeVideo extends EventEmitter<VideoSourceEvents> implements VideoSource {
  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
}

function ok(stdout: string): RunResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function jpeg(width = 3, height = 2): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
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

class ScreenshotService extends AndroidService {
  public screenshotCalls = 0;

  public override async screenshot(): Promise<Buffer> {
    this.screenshotCalls += 1;
    return jpeg(4, 3);
  }
}

const servers: ServeDroidServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function connectVideo(url: string): Promise<WebSocket> {
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
}

function screenshotRequest(url: string): Promise<Response> {
  return fetch(`${url}/api/v1/screenshot`, {
    headers: { authorization: "Bearer test-token" },
  });
}

describe("stream-first agent screenshots", () => {
  it("returns a decoded browser frame without invoking the ADB screenshot fallback", async () => {
    const service = new ScreenshotService(new FakeAdb(), device);
    const server = new ServeDroidServer(service, {
      token: "test-token",
      videoSource: new FakeVideo(),
    });
    servers.push(server);
    const session = await server.start();
    const socket = await connectVideo(session.url);
    socket.on("message", (data, binary) => {
      if (binary) return;
      const request = JSON.parse(String(data)) as { id: string };
      socket.send(
        JSON.stringify({
          schemaVersion: 1,
          type: "decoded-frame",
          id: request.id,
          mimeType: "image/jpeg",
          width: 3,
          height: 2,
          data: jpeg().toString("base64"),
        }),
      );
    });

    const response = await screenshotRequest(session.url);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-serve-droid-screenshot-source")).toBe("stream");
    expect(response.headers.get("x-serve-droid-screenshot-width")).toBe("3");
    expect(response.headers.get("x-serve-droid-screenshot-height")).toBe("2");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg());
    expect(service.screenshotCalls).toBe(0);
  });

  it("uses ADB immediately when no decoded-frame provider is connected", async () => {
    const service = new ScreenshotService(new FakeAdb(), device);
    const server = new ServeDroidServer(service, {
      token: "test-token",
      videoSource: new FakeVideo(),
    });
    servers.push(server);
    const session = await server.start();

    const response = await screenshotRequest(session.url);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-serve-droid-screenshot-source")).toBe("device");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg(4, 3));
    expect(service.screenshotCalls).toBe(1);
  });

  it("falls back after a connected browser returns a malformed frame", async () => {
    const service = new ScreenshotService(new FakeAdb(), device);
    const server = new ServeDroidServer(service, {
      token: "test-token",
      videoSource: new FakeVideo(),
    });
    servers.push(server);
    const session = await server.start();
    const socket = await connectVideo(session.url);
    socket.on("message", (data, binary) => {
      if (binary) return;
      const request = JSON.parse(String(data)) as { id: string };
      socket.send(
        JSON.stringify({
          schemaVersion: 1,
          type: "decoded-frame",
          id: request.id,
          mimeType: "image/jpeg",
          width: 300,
          height: 200,
          data: jpeg().toString("base64"),
        }),
      );
    });

    const response = await screenshotRequest(session.url);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-serve-droid-screenshot-source")).toBe("device");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg(4, 3));
    expect(service.screenshotCalls).toBe(1);
  });
});
