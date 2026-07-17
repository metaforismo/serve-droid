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
