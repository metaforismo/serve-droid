import { expect, test, type Page } from "@playwright/test";

const observation = {
  schemaVersion: 1,
  timestamp: "2026-08-20T01:00:00.000Z",
  device: {
    serial: "emulator-5554",
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
};

async function routeDemo(page: Page): Promise<void> {
  await page.route("**/api/v1/observe**", (route) =>
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
  await page.route("**/api/v1/recording", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ schemaVersion: 1, controllable: false, recording: null }),
    }),
  );
  await page.route("**/api/v1/screenshot", (route) => route.fulfill({ status: 204, body: "" }));
}

test("keeps the floating inspector clear of the Android surface at compact desktop widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await routeDemo(page);
  await page.goto("/?demo=1");

  const phone = page.locator(".phone");
  const inspector = page.locator(".inspector");
  await expect(phone).toBeVisible();
  await expect(inspector).toBeVisible();

  const phoneBox = await phone.boundingBox();
  const inspectorBox = await inspector.boundingBox();
  expect(phoneBox).not.toBeNull();
  expect(inspectorBox).not.toBeNull();
  expect(phoneBox!.x + phoneBox!.width + 12).toBeLessThanOrEqual(inspectorBox!.x);
});
