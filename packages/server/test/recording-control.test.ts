import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  public readonly logcat = new FakeProcess();
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
    return this.logcat as never;
  }
}

class FakeVideo extends EventEmitter<VideoSourceEvents> implements VideoSource {
  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
}

function ok(stdout: string): RunResult {
  return { stdout, stderr: "", exitCode: 0 };
}

const device: DeviceSummary = {
  serial: "recording-control-serial",
  state: "device",
  kind: "physical",
  model: "Recording Control Test",
  product: "fixture",
  manufacturer: "Test",
  apiLevel: 35,
  abi: "arm64-v8a",
};

const servers: ServeDroidServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function recordingRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "serve-droid-browser-recording-"));
  roots.push(root);
  return root;
}

async function startServer(controlDirectory?: string): Promise<{
  server: ServeDroidServer;
  video: FakeVideo;
  url: string;
}> {
  const video = new FakeVideo();
  const server = new ServeDroidServer(new AndroidService(new FakeAdb(), device), {
    token: "recording-token",
    videoSource: video,
    ...(controlDirectory
      ? {
          recordingControl: {
            directory: controlDirectory,
            maxBytes: 1024 * 1024,
            maxDurationMs: 60_000,
          },
        }
      : {}),
  });
  servers.push(server);
  const session = await server.start();
  return { server, video, url: session.url };
}

function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      authorization: "Bearer recording-token",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

describe("browser recording controls", () => {
  it("stays unavailable unless the host authorizes a recording root", async () => {
    const { url } = await startServer();
    const state = await request(`${url}/api/v1/recording`);
    await expect(state.json()).resolves.toEqual({
      schemaVersion: 1,
      controllable: false,
      recording: null,
    });

    const response = await request(`${url}/api/v1/recording`, {
      method: "POST",
      body: JSON.stringify({ active: true }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  it("serializes start requests, rejects browser path injection, records bytes, and finalizes on stop", async () => {
    const root = await recordingRoot();
    const { video, url } = await startServer(root);

    const injected = await request(`${url}/api/v1/recording`, {
      method: "POST",
      body: JSON.stringify({ active: true, directory: "/tmp/not-allowed" }),
    });
    expect(injected.status).toBe(400);

    const [firstResponse, secondResponse] = await Promise.all([
      request(`${url}/api/v1/recording`, {
        method: "POST",
        body: JSON.stringify({ active: true }),
      }),
      request(`${url}/api/v1/recording`, {
        method: "POST",
        body: JSON.stringify({ active: true }),
      }),
    ]);
    const first = (await firstResponse.json()) as {
      recording: { active: boolean; directory: string };
    };
    const second = (await secondResponse.json()) as typeof first;
    expect(first.recording.active).toBe(true);
    expect(second.recording.directory).toBe(first.recording.directory);
    expect((await readdir(root)).filter((name) => name.startsWith("session-"))).toHaveLength(1);

    const bytes = Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]);
    video.emit("data", bytes);

    const stoppedResponse = await request(`${url}/api/v1/recording`, {
      method: "POST",
      body: JSON.stringify({ active: false }),
    });
    const stopped = (await stoppedResponse.json()) as {
      recording: { active: boolean; directory: string; reason: string };
    };
    expect(stopped.recording).toMatchObject({ active: false, reason: "completed" });
    await expect(readFile(join(stopped.recording.directory, "video.h264"))).resolves.toEqual(bytes);
    const manifest = JSON.parse(
      await readFile(join(stopped.recording.directory, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({ status: "completed", serial: device.serial });
  });
});
