import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test, type BrowserContext } from "@playwright/test";
import type {
  AdbRunner,
  DeviceSummary,
  RunResult,
} from "../../core/src/index.js";
import type { VideoSource, VideoSourceEvents } from "../../server/src/video.js";

const execFileAsync = promisify(execFile);

class FakeProcess extends EventEmitter {
  public stdin = new PassThrough();
  public stdout = new PassThrough();
  public stderr = new PassThrough();

  public kill(): boolean {
    this.emit("close", 0);
    return true;
  }
}

class BrowserSessionAdb implements AdbRunner {
  public readonly calls: string[][] = [];

  public constructor(private readonly screenshotPng: Buffer) {}

  public async run(args: readonly string[]): Promise<RunResult> {
    this.calls.push([...args]);
    const key = args.join(" ");
    if (key === "shell wm size") return ok("Physical size: 1080x1920\n");
    if (key === "shell wm density") return ok("Physical density: 420\n");
    if (key === "shell dumpsys input") return ok("SurfaceOrientation: 0\n");
    if (key === "shell dumpsys activity activities") {
      return ok(
        "mResumedActivity: ActivityRecord{123 u0 dev.servedroid.fixture/.MainActivity t1}\n",
      );
    }
    if (key === "shell pidof dev.servedroid.fixture") return ok("7412\n");
    if (key === "exec-out uiautomator dump /dev/tty") {
      return ok('<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"></hierarchy>');
    }
    if (key.startsWith("shell input keyevent ")) return ok("");
    return ok("");
  }

  public async capture(): Promise<Buffer> {
    return Buffer.from(this.screenshotPng);
  }

  public spawn(): never {
    return new FakeProcess() as never;
  }
}

class BrowserSessionVideo extends EventEmitter<VideoSourceEvents> implements VideoSource {
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

function commandList(adb: BrowserSessionAdb): string[] {
  return adb.calls.map((args) => args.join(" "));
}

test("two independent browser clients view and control one shared session", async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "One browser engine is sufficient for the concurrency gate.");
  test.setTimeout(90_000);

  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "serve-droid-shared-browser-"));
  const streamPath = join(fixtureDirectory, "shared.h264");
  const contexts: BrowserContext[] = [];
  let stopServer: (() => Promise<void>) | undefined;

  try {
    await execFileAsync("pnpm", ["build"], {
      cwd: repositoryRoot,
      maxBuffer: 8 * 1024 * 1024,
    });
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=96x160:r=10:d=0.4",
      "-c:v",
      "libx264",
      "-profile:v",
      "baseline",
      "-level",
      "4.0",
      "-pix_fmt",
      "yuv420p",
      "-x264-params",
      "bframes=0:keyint=1:aud=1",
      "-f",
      "h264",
      "-y",
      streamPath,
    ]);

    const coreUrl = pathToFileURL(join(repositoryRoot, "packages/core/dist/index.js")).href;
    const serverUrl = pathToFileURL(join(repositoryRoot, "packages/server/dist/index.js")).href;
    const { AndroidService } = (await import(coreUrl)) as typeof import("../../core/src/index.js");
    const { ServeDroidServer } = (await import(serverUrl)) as typeof import("../../server/src/index.js");
    const { default: sharp } = await import("sharp");

    const screenshotPng = await sharp({
      create: {
        width: 96,
        height: 160,
        channels: 3,
        background: { r: 18, g: 20, b: 24 },
      },
    })
      .png()
      .toBuffer();
    const adb = new BrowserSessionAdb(screenshotPng);
    const video = new BrowserSessionVideo();
    const device: DeviceSummary = {
      serial: "shared-browser-device",
      state: "device",
      kind: "physical",
      model: "Pixel 9 Pro",
      product: "tokay",
      manufacturer: "Google",
      apiLevel: 35,
      abi: "arm64-v8a",
    };
    const server = new ServeDroidServer(new AndroidService(adb, device), {
      token: "shared-browser-token",
      videoSource: video,
      webRoot: join(repositoryRoot, "packages/web/dist"),
    });
    stopServer = () => server.stop();
    const session = await server.start();

    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    contexts.push(firstContext, secondContext);
    const [firstPage, secondPage] = await Promise.all([
      firstContext.newPage(),
      secondContext.newPage(),
    ]);

    await Promise.all([firstPage.goto(session.url), secondPage.goto(session.url)]);
    for (const page of [firstPage, secondPage]) {
      await expect(page.locator(".topbar")).toContainText("serve-droid");
      await expect(page.locator(".device-meta")).toContainText("Pixel 9 Pro");
      await expect(page.locator(".device-meta")).toContainText(/Streaming · (WebCodecs|TinyH264)/u);
      expect(page.url()).not.toContain("shared-browser-token");
    }
    expect(video.starts).toBe(1);

    video.emit("data", await readFile(streamPath));
    await Promise.all(
      [firstPage, secondPage].map((page) =>
        expect(page.locator(".device-meta")).toContainText(/[1-9]\d* frames/u, { timeout: 10_000 }),
      ),
    );

    await firstPage.getByRole("button", { name: "Home" }).click();
    await secondPage.getByRole("button", { name: "Back" }).click();
    await expect.poll(() => commandList(adb)).toContain("shell input keyevent KEYCODE_HOME");
    await expect.poll(() => commandList(adb)).toContain("shell input keyevent KEYCODE_BACK");

    await expect(firstPage.getByText("Home sent", { exact: true })).toBeVisible();
    await expect(secondPage.getByText("Back sent", { exact: true })).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await stopServer?.();
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
