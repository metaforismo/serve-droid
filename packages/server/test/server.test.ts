import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  AndroidService,
  type AdbRunner,
  type DeviceSummary,
  type RunResult,
} from "../../core/src/index.js";
import { ServeDroidServer } from "../src/server.js";
import { SCRCPY_SERVER_SHA256, type VideoSource, type VideoSourceEvents } from "../src/video.js";

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
});

describe("vendored scrcpy server", () => {
  it("matches the recorded checksum", async () => {
    const data = await readFile(resolve(import.meta.dirname, "../vendor/scrcpy-server-v3.3.3"));
    expect(createHash("sha256").update(data).digest("hex")).toBe(SCRCPY_SERVER_SHA256);
  });
});
