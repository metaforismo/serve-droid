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
  await page.route("**/api/v1/activity**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        events: [
          {
            schemaVersion: 1,
            cursor: "1",
            timestamp: "2026-08-20T01:00:00.000Z",
            type: "session-start",
            details: { serial: "emulator-5554", width: 1080, height: 2400 },
          },
          {
            schemaVersion: 1,
            cursor: "2",
            timestamp: "2026-08-20T01:00:01.000Z",
            type: "action",
            details: {
              action: "type",
              textLength: 16,
              text: "user-secret-text",
            },
          },
        ],
        nextCursor: "2",
        truncated: false,
      }),
    }),
  );
  await page.route("**/api/v1/screenshot", (route) => route.fulfill({ status: 204, body: "" }));
}

test("shows privacy-safe Activity and lets the user reclaim inspector space", async ({ page }) => {
  await routeDemo(page);
  await page.goto("/?demo=1");

  await page.getByRole("tab", { name: /Activity/u }).click();
  await expect(page.getByRole("tab", { name: /Activity/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("Session started")).toBeVisible();
  await expect(page.getByText("Device action")).toBeVisible();
  await expect(page.locator(".activity-panel")).toContainText("type");
  await expect(page.locator(".activity-panel")).not.toContainText("user-secret-text");

  const toggle = page.getByRole("button", { name: "Toggle inspector" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".inspector")).toBeHidden();

  await toggle.click();
  await expect(page.locator(".inspector")).toBeVisible();
  await expect(page.getByText("Session started")).toBeVisible();
});
