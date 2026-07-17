import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
interface BrowserVideoModule {
  createH264CanvasPlayer(options: {
    canvas: HTMLCanvasElement;
    onFrame: () => void;
    onError: (message: string) => void;
  }): Promise<{ backend: string; push(chunk: ArrayBuffer): void; close(): void }>;
}
let fixtureDirectory = "";
let baselineSample: number[] = [];
let performancePackets: number[][] = [];

function splitAccessUnits(data: Uint8Array): number[][] {
  const starts: number[] = [0];
  for (let index = 0; index < data.length - 4; index += 1) {
    if (data[index] !== 0 || data[index + 1] !== 0) continue;
    const prefix =
      data[index + 2] === 1 ? 3 : data[index + 2] === 0 && data[index + 3] === 1 ? 4 : 0;
    if (!prefix) continue;
    if (((data[index + prefix] ?? 0) & 0x1f) === 9 && index > 0) starts.push(index);
    index += prefix - 1;
  }
  return starts.map((start, index) => [...data.slice(start, starts[index + 1])]);
}

test.beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "serve-droid-codec-test-"));
  const path = join(fixtureDirectory, "baseline.h264");
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=64x64:r=10:d=0.3",
    "-c:v",
    "libx264",
    "-profile:v",
    "baseline",
    "-level",
    "4.0",
    "-x264-params",
    "bframes=0:keyint=1",
    "-f",
    "h264",
    "-y",
    path,
  ]);
  baselineSample = [...(await readFile(path))];
  const performancePath = join(fixtureDirectory, "performance.h264");
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=640x360:r=30:d=3",
    "-c:v",
    "libx264",
    "-profile:v",
    "baseline",
    "-level",
    "4.0",
    "-x264-params",
    "bframes=0:keyint=30:aud=1",
    "-f",
    "h264",
    "-y",
    performancePath,
  ]);
  performancePackets = splitAccessUnits(await readFile(performancePath));
});

test.afterAll(async () => {
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

test("selects an available video decoder without disabling the cockpit", async ({ page }) => {
  await page.goto("/");
  const hasWebCodecs = await page.evaluate(() => typeof VideoDecoder !== "undefined");
  const expected = hasWebCodecs ? "WebCodecs" : "TinyH264";
  await expect(page.locator(".device-meta")).toContainText(expected);
  await expect(page.locator('button[title="Back"]')).toBeEnabled();
  await expect(page.getByRole("button", { name: /UI tree/u })).toBeEnabled();
});

test("falls back to TinyH264 when WebCodecs is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(globalThis, "VideoDecoder");
  });
  await page.goto("/");
  await expect(page.locator(".device-meta")).toContainText("TinyH264");
  await expect(page.locator('button[title="Home"]')).toBeEnabled();
});

test("software fallback decodes a generated Baseline Level 4 stream", async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(globalThis, "VideoDecoder");
  });
  await page.goto("/?demo");
  const result = await page.evaluate(async (bytes) => {
    const modulePath = "/src/video.ts";
    const video = (await import(modulePath)) as BrowserVideoModule;
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    let frames = 0;
    let error = "";
    const startedAt = performance.now();
    const player = await video.createH264CanvasPlayer({
      canvas,
      onFrame: () => {
        frames += 1;
      },
      onError: (message) => {
        error = message;
      },
    });
    player.push(Uint8Array.from(bytes).buffer);
    while (frames === 0 && !error && performance.now() - startedAt < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const elapsedMs = performance.now() - startedAt;
    player.close();
    return { backend: player.backend, frames, error, elapsedMs };
  }, baselineSample);
  test.info().annotations.push({
    type: "tinyh264-first-frame-ms",
    description: result.elapsedMs.toFixed(1),
  });
  expect(result).toMatchObject({ backend: "tinyh264", error: "" });
  expect(result.frames).toBeGreaterThan(0);
  expect(result.elapsedMs).toBeLessThan(10_000);
});

test("measures software decoder CPU and latency against WebCodecs", async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Chromium CDP exposes comparable process CPU counters.");
  const probe = await browser.newPage();
  await probe.goto("/?demo");
  const webCodecsSupported = await probe.evaluate(async () =>
    typeof VideoDecoder === "undefined"
      ? false
      : (
          await VideoDecoder.isConfigSupported({
            codec: "avc1.42C028",
            optimizeForLatency: true,
            hardwareAcceleration: "prefer-hardware",
          })
        ).supported,
  );
  await probe.close();
  test.skip(!webCodecsSupported, "This browser build has no supported H.264 WebCodecs path.");

  const run = async (forceFallback: boolean) => {
    const page = await browser.newPage();
    if (forceFallback) {
      await page.addInitScript(() => Reflect.deleteProperty(globalThis, "VideoDecoder"));
    }
    const cdp = await browser.newBrowserCDPSession();
    const cpu = async () => {
      const result = (await cdp.send("SystemInfo.getProcessInfo")) as {
        processInfo: Array<{ cpuTime: number }>;
      };
      return result.processInfo.reduce((total, process) => total + process.cpuTime, 0);
    };
    const cpuBefore = await cpu();
    await page.goto("/?demo");
    const result = await page.evaluate(async (packets) => {
      const modulePath = "/src/video.ts";
      const video = (await import(modulePath)) as BrowserVideoModule;
      const canvas = document.createElement("canvas");
      document.body.append(canvas);
      let frames = 0;
      let error = "";
      const startedAt = performance.now();
      const player = await video.createH264CanvasPlayer({
        canvas,
        onFrame: () => {
          frames += 1;
        },
        onError: (message) => {
          error = message;
        },
      });
      for (const bytes of packets) {
        player.push(Uint8Array.from(bytes).buffer);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      while (frames < 60 && !error && performance.now() - startedAt < 15_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const elapsedMs = performance.now() - startedAt;
      player.close();
      return { backend: player.backend, frames, error, elapsedMs };
    }, performancePackets);
    const cpuSeconds = (await cpu()) - cpuBefore;
    await page.close();
    return { ...result, cpuSeconds };
  };

  const webcodecs = await run(false);
  const tinyh264 = await run(true);
  test.info().annotations.push({
    type: "decoder-performance",
    description: JSON.stringify({ webcodecs, tinyh264 }),
  });
  expect(webcodecs).toMatchObject({ backend: "webcodecs", error: "" });
  expect(tinyh264).toMatchObject({ backend: "tinyh264", error: "" });
  expect(webcodecs.frames).toBeGreaterThanOrEqual(60);
  expect(tinyh264.frames).toBeGreaterThanOrEqual(60);
  expect(webcodecs.cpuSeconds).toBeGreaterThanOrEqual(0);
  expect(tinyh264.cpuSeconds).toBeGreaterThanOrEqual(0);
});
