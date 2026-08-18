import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";
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
  public readonly calls: string[][] = [];
  public readonly logcat = new FakeProcess();
  public failInstall = false;

  public async run(args: readonly string[]): Promise<RunResult> {
    this.calls.push([...args]);
    const command = args.join(" ");
    if (command === "shell wm size") return ok("Physical size: 1080x1920\n");
    if (command === "shell wm density") return ok("Physical density: 420\n");
    if (command === "shell dumpsys input") return ok("SurfaceOrientation: 0\n");
    if (this.failInstall && command.startsWith("install -r ")) {
      return { stdout: "", stderr: "install failed", exitCode: 1 };
    }
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
  serial: "transport-serial",
  state: "device",
  kind: "physical",
  model: "Transport Test",
  product: "fixture",
  manufacturer: "Test",
  apiLevel: 35,
  abi: "arm64-v8a",
};

const servers: ServeDroidServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function startServer(): Promise<{
  adb: FakeAdb;
  server: ServeDroidServer;
  url: string;
}> {
  const adb = new FakeAdb();
  const server = new ServeDroidServer(new AndroidService(adb, device), {
    token: "test-token",
    videoSource: new FakeVideo(),
  });
  servers.push(server);
  const session = await server.start();
  return { adb, server, url: session.url };
}

function authenticatedJson(body: string): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body,
  };
}

function uploadHeaders(name: string): Record<string, string> {
  return {
    authorization: "Bearer test-token",
    accept: "text/event-stream",
    "content-type": "application/octet-stream",
    "x-file-name": encodeURIComponent(name),
  };
}

async function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(String(data)) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

describe("HTTP transport envelopes", () => {
  it("returns INVALID_ARGUMENT for malformed and non-object JSON before device input", async () => {
    const { adb, url } = await startServer();

    for (const body of ["{", "null", "[]"]) {
      const response = await fetch(`${url}/api/v1/actions`, authenticatedJson(body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "INVALID_ARGUMENT" },
      });
    }

    expect(adb.calls.some((call) => call[0] === "shell" && call[1] === "input")).toBe(false);
  });

  it("returns INVALID_ARGUMENT for malformed upload filename encoding", async () => {
    const { adb, url } = await startServer();
    const response = await fetch(`${url}/api/v1/files`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "x-file-name": "%E0%A4%A",
      },
      body: Buffer.alloc(0),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(adb.calls.some((call) => call[0] === "push" || call[0] === "install")).toBe(false);
  });
});

describe("file operation progress", () => {
  it("streams install and push phases while preserving final result envelopes", async () => {
    const { adb, url } = await startServer();

    const installResponse = await fetch(`${url}/api/v1/files`, {
      method: "POST",
      headers: uploadHeaders("example.apk"),
      body: Buffer.from("apk"),
    });
    expect(installResponse.status).toBe(200);
    expect(installResponse.headers.get("content-type")).toContain("text/event-stream");
    const install = await installResponse.text();
    expect(install).toContain('"operation":"install","phase":"installing"');
    expect(install).toContain('"operation":"install","phase":"completed"');
    expect(install).toContain(
      'event: result\ndata: {"schemaVersion":1,"ok":true,"operation":"install"}',
    );
    expect(install.indexOf('"phase":"installing"')).toBeLessThan(
      install.indexOf('"phase":"completed"'),
    );

    const pushResponse = await fetch(`${url}/api/v1/files`, {
      method: "POST",
      headers: uploadHeaders("example.txt"),
      body: Buffer.from("hello"),
    });
    expect(pushResponse.status).toBe(200);
    const push = await pushResponse.text();
    expect(push).toContain('"operation":"push","phase":"pushing"');
    expect(push).toContain('"operation":"push","phase":"completed"');
    expect(push).toContain('"operation":"push","destination":"/sdcard/Download/example.txt"');

    expect(adb.calls.some((call) => call[0] === "install" && call[1] === "-r")).toBe(true);
    expect(adb.calls.some((call) => call[0] === "push")).toBe(true);
  });

  it("streams a typed failure after progress has already started", async () => {
    const { adb, url } = await startServer();
    adb.failInstall = true;

    const response = await fetch(`${url}/api/v1/files`, {
      method: "POST",
      headers: uploadHeaders("broken.apk"),
      body: Buffer.from("apk"),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"operation":"install","phase":"installing"');
    expect(body).toContain('"operation":"install","phase":"failed"');
    expect(body).toContain("event: error");
    expect(body).toContain('"code":"ADB_FAILED"');
    expect(body).not.toContain("event: result");
  });
});

describe("control WebSocket envelopes", () => {
  it("returns INVALID_ARGUMENT for malformed and non-object JSON", async () => {
    const { url } = await startServer();
    const socket = new WebSocket(url.replace(/^http/u, "ws") + "/api/v1/control", [
      "serve-droid",
      "token.test-token",
    ]);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    for (const body of ["{", "null"]) {
      const message = nextMessage(socket);
      socket.send(body);
      await expect(message).resolves.toMatchObject({
        error: { code: "INVALID_ARGUMENT" },
      });
    }
    socket.close();
  });
});

describe("Logcat SSE resume", () => {
  it("honors Last-Event-ID and emits cursor ids on resumed entries", async () => {
    const { adb, url } = await startServer();
    adb.logcat.stdout.write(
      "08-18 12:00:00.000  1234  1234 I Fixture: first\n" +
        "08-18 12:00:01.000  1234  1234 I Fixture: second\n",
    );
    await new Promise((resolve) => setImmediate(resolve));

    const response = await fetch(`${url}/api/v1/logs?system=true&since=0`, {
      headers: {
        authorization: "Bearer test-token",
        "last-event-id": "1",
      },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("id: 2");
    expect(text).toContain("second");
    expect(text).not.toContain("first");
    await reader.cancel();
  });
});
