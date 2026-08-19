import { expect, test } from "@playwright/test";

const token = "recording-browser-token";
const observation = {
  schemaVersion: 1,
  timestamp: "2026-08-19T12:00:00.000Z",
  device: { serial: "emulator-5554", model: "Pixel 9 Pro", apiLevel: 35, kind: "emulator" },
  display: { width: 1080, height: 2400, orientation: "portrait" },
  foregroundApp: { packageName: "dev.servedroid.fixture", activity: ".MainActivity" },
  screenshot: { mimeType: "image/jpeg", width: 1080, height: 2400, url: "/api/v1/screenshot" },
  elements: [],
  logs: [],
  nextLogCursor: "0",
};

test("host-authorized recording can be started and stopped from the cockpit", async ({ page }) => {
  let active = false;
  let writes = 0;
  const recording = () => ({
    schemaVersion: 1,
    controllable: true,
    recording: active
      ? {
          schemaVersion: 1,
          active: true,
          directory: "/private/recordings/session-browser",
          startedAt: "2026-08-19T12:00:00.000Z",
          bytesWritten: 4096,
          maxBytes: 1024 * 1024,
          maxDurationMs: 60_000,
          reason: "active",
        }
      : null,
  });

  await page.route("**/api/v1/observe?**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(observation) }),
  );
  await page.route("**/api/v1/remote-access", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        active: false,
        provider: null,
        publicUrl: null,
        expiresAt: null,
      }),
    }),
  );
  await page.route("**/api/v1/recording", async (route) => {
    if (route.request().method() === "POST") {
      const authorization = route.request().headers().authorization;
      expect(authorization).toBe(`Bearer ${token}`);
      const body = route.request().postDataJSON() as { active: boolean };
      active = body.active;
      writes += 1;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(recording()) });
  });
  await page.route("**/api/v1/screenshot", (route) =>
    route.fulfill({ status: 204, contentType: "image/jpeg", body: "" }),
  );
  await page.routeWebSocket("**/api/v1/video", (socket) => socket.onMessage(() => undefined));
  await page.routeWebSocket("**/api/v1/control", (socket) => {
    socket.onMessage(() => socket.send(JSON.stringify({ schemaVersion: 1, ok: true })));
  });

  await page.goto(`/#token=${token}`);
  const start = page.getByRole("button", { name: "Start session recording" });
  await expect(start).toBeVisible();
  await start.click();
  await expect(page.getByRole("button", { name: "Stop session recording" })).toBeVisible();
  await expect(page.locator(".recording-badge")).toHaveText("Recording");

  await page.getByRole("button", { name: "Stop session recording" }).click();
  await expect(page.getByRole("button", { name: "Start session recording" })).toBeVisible();
  await expect(page.locator(".recording-badge")).toHaveCount(0);
  expect(writes).toBe(2);
});
