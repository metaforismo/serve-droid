import { describe, expect, it } from "vitest";
import { SessionActivityBuffer, sanitizeActivityDetails } from "../src/activity.js";

describe("session activity buffer", () => {
  it("keeps only allowlisted privacy-safe event metadata", () => {
    expect(
      sanitizeActivityDetails("action", {
        action: "type",
        textLength: 18,
        text: "user-secret-text",
        url: "https://secret.example/path",
        token: "bearer-secret",
        path: "/private/file.txt",
      }),
    ).toEqual({ action: "type", textLength: 18 });

    expect(
      sanitizeActivityDetails("app", {
        operation: "deep-link",
        packageName: "dev.servedroid.fixture",
        url: "servedroid://secret/value",
      }),
    ).toEqual({ operation: "deep-link", packageName: "dev.servedroid.fixture" });
  });

  it("bounds retained entries and reports when a resume cursor fell behind", () => {
    const activity = new SessionActivityBuffer(3);
    activity.append("action", { action: "tap", x: 0.1, y: 0.2 });
    activity.append("action", { action: "tap", x: 0.2, y: 0.3 });
    activity.append("app", { operation: "launch", packageName: "dev.example" });
    activity.append("screenshot", { source: "stream", width: 1080, height: 2400 });

    expect(activity.read("0")).toMatchObject({
      nextCursor: "4",
      truncated: true,
      events: [
        { cursor: "2", type: "action" },
        { cursor: "3", type: "app" },
        { cursor: "4", type: "screenshot" },
      ],
    });
    expect(activity.read("3")).toMatchObject({
      nextCursor: "4",
      truncated: false,
      events: [{ cursor: "4", type: "screenshot" }],
    });
  });

  it("rejects malformed or unsafe cursors and limits", () => {
    expect(() => new SessionActivityBuffer(0)).toThrow(/between 1 and 1024/u);
    const activity = new SessionActivityBuffer();
    expect(() => activity.read("-1")).toThrow(/non-negative integer/u);
    expect(() => activity.read("1.5")).toThrow(/non-negative integer/u);
    expect(() => activity.read(String(Number.MAX_SAFE_INTEGER + 1))).toThrow(/supported range/u);
  });

  it("caps long string metadata instead of retaining unbounded values", () => {
    const activity = new SessionActivityBuffer();
    const event = activity.append("app", {
      operation: "launch",
      packageName: "x".repeat(2_000),
    });
    expect(Buffer.byteLength(String(event.details.packageName))).toBeLessThanOrEqual(256);
  });
});
