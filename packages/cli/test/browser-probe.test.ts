import { describe, expect, it } from "vitest";
import {
  classifyBrowserCapabilities,
  parseBrowserCapabilities,
  probeBrowser,
  type BrowserCapabilities,
} from "../src/browser-probe.js";

const completeCapabilities: BrowserCapabilities = {
  userAgent: "Serve Droid Test Browser",
  secureContext: true,
  fetch: true,
  webSocket: true,
  webAssembly: true,
  worker: true,
  canvas2d: true,
  webgl: true,
  webCodecs: true,
  clipboardRead: true,
  fileApi: true,
};

describe("browser capability classification", () => {
  it("prefers an H.264 WebCodecs path when it is supported", () => {
    expect(classifyBrowserCapabilities(completeCapabilities)).toMatchObject({
      control: true,
      decoder: "webcodecs",
      ready: true,
      warnings: [],
    });
  });

  it("selects the bounded TinyH264 fallback when WebCodecs is unavailable", () => {
    expect(
      classifyBrowserCapabilities({ ...completeCapabilities, webCodecs: false }),
    ).toMatchObject({
      control: true,
      decoder: "tinyh264",
      ready: true,
    });
  });

  it("fails closed when control or every video path is unavailable", () => {
    const result = classifyBrowserCapabilities({
      ...completeCapabilities,
      fetch: false,
      webCodecs: false,
      webgl: false,
    });

    expect(result).toMatchObject({
      control: false,
      decoder: "unavailable",
      ready: false,
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Fetch and WebSocket"),
        expect.stringContaining("Video requires"),
      ]),
    );
  });

  it("accepts only a complete, bounded boolean report", () => {
    expect(parseBrowserCapabilities(completeCapabilities)).toEqual(completeCapabilities);
    expect(() => parseBrowserCapabilities({ ...completeCapabilities, worker: "yes" })).toThrow(
      "worker must be a boolean",
    );
    expect(() =>
      parseBrowserCapabilities({
        ...completeCapabilities,
        userAgent: "x".repeat(513),
      }),
    ).toThrow("userAgent must contain 1 to 512 characters");
  });
});

describe("one-time browser probe", () => {
  it("binds loopback, exposes no query credential, and accepts one bounded report", async () => {
    let openedUrl = "";
    const fallbackCapabilities = { ...completeCapabilities, webCodecs: false };

    const result = await probeBrowser({
      timeoutMs: 2_000,
      launch: async (url) => {
        openedUrl = url;
        const page = await fetch(url);
        expect(page.status).toBe(200);
        expect(page.headers.get("cache-control")).toBe("no-store");
        expect(page.headers.get("referrer-policy")).toBe("no-referrer");
        expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
        const html = await page.text();
        expect(html).toContain("VideoDecoder.isConfigSupported");
        expect(html).toContain("No browser data is sent outside this one-time loopback server.");

        const post = await fetch(`${url}/result`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(fallbackCapabilities),
        });
        expect(post.status).toBe(204);
      },
    });

    const parsed = new URL(openedUrl);
    expect(parsed.hostname).toBe("127.0.0.1");
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("");
    expect(parsed.pathname).toMatch(/^\/[a-f0-9]{48}$/u);
    expect(result).toMatchObject({
      capabilities: fallbackCapabilities,
      decoder: "tinyh264",
      ready: true,
    });
  });

  it("rejects malformed reports without waiting for the timeout", async () => {
    await expect(
      probeBrowser({
        timeoutMs: 2_000,
        launch: async (url) => {
          await fetch(`${url}/result`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userAgent: "incomplete" }),
          });
        },
      }),
    ).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
      message: "Browser returned an invalid capability report.",
    });
  });

  it("closes a probe that never returns a result", async () => {
    await expect(probeBrowser({ timeoutMs: 25, launch: () => undefined })).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
      details: { timeoutMs: 25 },
    });
  });
});
