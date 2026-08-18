import { describe, expect, it } from "vitest";
import { reportMcpProgress } from "../src/progress.js";

describe("MCP progress notifications", () => {
  it("does nothing when the caller did not request progress", async () => {
    const sent: unknown[] = [];
    await reportMcpProgress(
      { sendNotification: async (notification) => void sent.push(notification) },
      1,
      2,
      "Installing APK on Android.",
    );
    expect(sent).toEqual([]);
  });

  it("echoes the opaque progress token and emits monotonic step metadata", async () => {
    const sent: unknown[] = [];
    await reportMcpProgress(
      {
        _meta: { progressToken: "install-7" },
        sendNotification: async (notification) => void sent.push(notification),
      },
      1,
      2,
      "Installing APK on Android.",
    );
    expect(sent).toEqual([
      {
        method: "notifications/progress",
        params: {
          progressToken: "install-7",
          progress: 1,
          total: 2,
          message: "Installing APK on Android.",
        },
      },
    ]);
  });
});
