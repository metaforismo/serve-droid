import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  AndroidService,
  type AdbRunner,
  type DeviceSummary,
  type RunResult,
} from "@serve-droid/core";
import { afterEach, describe, expect, it } from "vitest";
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
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function authorized(token = "test-token"): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

describe("session activity routing", () => {
  it("requires authentication and resumes privacy-filtered structured events", async () => {
    const server = new ServeDroidServer(new AndroidService(new FakeAdb(), device), {
      token: "test-token",
      videoSource: new FakeVideo(),
    });
    servers.push(server);
    const session = await server.start();

    const unauthorized = await fetch(`${session.url}/api/v1/activity`);
    expect(unauthorized.status).toBe(401);

    const initial = await fetch(`${session.url}/api/v1/activity`, {
      headers: authorized(),
    });
    expect(initial.status).toBe(200);
    const firstPage = (await initial.json()) as {
      events: Array<{ cursor: string; type: string; details: Record<string, unknown> }>;
      nextCursor: string;
      truncated: boolean;
    };
    expect(firstPage).toMatchObject({ truncated: false });
    expect(firstPage.events).toContainEqual(
      expect.objectContaining({
        type: "session-start",
        details: { serial: "serial", width: 1080, height: 1920 },
      }),
    );

    const secret = "user-secret-text";
    const action = await fetch(`${session.url}/api/v1/actions`, {
      method: "POST",
      headers: { ...authorized(), "content-type": "application/json" },
      body: JSON.stringify({ type: "type", text: secret }),
    });
    expect(action.status).toBe(200);

    const resumed = await fetch(
      `${session.url}/api/v1/activity?since=${encodeURIComponent(firstPage.nextCursor)}`,
      { headers: authorized() },
    );
    expect(resumed.status).toBe(200);
    const resumedText = await resumed.text();
    expect(resumedText).not.toContain(secret);
    const resumedPage = JSON.parse(resumedText) as {
      events: Array<{ type: string; details: Record<string, unknown> }>;
    };
    expect(resumedPage.events).toEqual([
      expect.objectContaining({
        type: "action",
        details: { action: "type", textLength: secret.length },
      }),
    ]);
  });

  it("returns a typed error for malformed activity cursors", async () => {
    const server = new ServeDroidServer(new AndroidService(new FakeAdb(), device), {
      token: "test-token",
      videoSource: new FakeVideo(),
    });
    servers.push(server);
    const session = await server.start();

    const response = await fetch(`${session.url}/api/v1/activity?since=-1`, {
      headers: authorized(),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_ARGUMENT" },
    });
  });
});
