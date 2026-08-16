import { expect, test } from "@playwright/test";

const screenshotPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9h8AAAAASUVORK5CYII=",
  "base64",
);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "__SERVE_DROID_BOOTSTRAP__", {
      configurable: true,
      writable: true,
      value: { token: "browser-test-token" },
    });
  });

  await page.route("**/api/v1/observe?**", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        timestamp: "2026-08-16T21:30:00.000Z",
        device: {
          serial: "emulator-demo",
          model: "Pixel 9 Pro",
          apiLevel: 35,
          kind: "emulator",
        },
        display: { width: 1080, height: 2400, orientation: "portrait" },
        foregroundApp: { packageName: "dev.servedroid.fixture", activity: ".MainActivity" },
        screenshot: {
          mimeType: "image/jpeg",
          width: 1080,
          height: 2400,
          url: "/api/v1/screenshot",
        },
        elements: [],
        logs: [],
        nextLogCursor: "0",
      }),
    }),
  );
  await page.route("**/api/v1/remote-access", async (route) =>
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
  await page.route("**/api/v1/screenshot", async (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: screenshotPng }),
  );
});

test("captures, previews, and downloads a bounded screenshot fallback", async ({ page }) => {
  await page.goto("/?demo");

  await page.getByRole("button", { name: "Capture screenshot" }).click();
  const notice = page.getByLabel("Captured screenshot");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Screenshot captured");
  await expect(notice).toContainText("Authenticated device fallback");
  await expect(notice.getByRole("img", { name: "Captured Android screen" })).toHaveAttribute(
    "src",
    /^blob:/u,
  );

  const downloadPromise = page.waitForEvent("download");
  await notice.getByRole("button", { name: "Download screenshot" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^serve-droid-screenshot-.*\.png$/u);

  await notice.getByRole("button", { name: "Dismiss screenshot" }).click();
  await expect(notice).toBeHidden();
});
