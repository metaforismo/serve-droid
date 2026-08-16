import { expect, test, type Page } from "@playwright/test";

async function openCockpit(page: Page, actions: Array<Record<string, unknown>>): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "__SERVE_DROID_BOOTSTRAP__", {
      configurable: true,
      writable: true,
      value: { token: "browser-test-token" },
    });
  });

  await page.route("**/api/v1/actions", async (route) => {
    actions.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ schemaVersion: 1, ok: true }),
    });
  });
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
  await page.route("**/api/v1/observe?**", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        timestamp: "2026-08-17T00:00:00.000Z",
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
  await page.route("**/api/v1/screenshot", async (route) =>
    route.fulfill({ status: 204, contentType: "image/jpeg", body: "" }),
  );

  await page.goto("/?demo");
  await expect(page.getByLabel("Live Android device. Click to tap or drag to swipe.")).toBeVisible();
}

test("coalesces a trackpad burst into one bounded Android swipe", async ({ page }) => {
  const actions: Array<Record<string, unknown>> = [];
  await openCockpit(page, actions);
  const canvas = page.getByLabel("Live Android device. Click to tap or drag to swipe.");

  await canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    for (const deltaY of [24, 36, 48]) {
      element.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: bounds.left + bounds.width * 0.5,
          clientY: bounds.top + bounds.height * 0.6,
          deltaY,
          deltaMode: 0,
        }),
      );
    }
  });

  await expect.poll(() => actions.length).toBe(1);
  const swipe = actions[0]!;
  expect(swipe.type).toBe("swipe");
  expect(Number(swipe.y2)).toBeLessThan(Number(swipe.y1));
  expect(Number(swipe.durationMs)).toBeGreaterThanOrEqual(90);
  expect(Number(swipe.durationMs)).toBeLessThanOrEqual(250);
  for (const coordinate of ["x1", "y1", "x2", "y2"] as const) {
    expect(Number(swipe[coordinate])).toBeGreaterThanOrEqual(0);
    expect(Number(swipe[coordinate])).toBeLessThanOrEqual(1);
  }
  await expect(page.getByTestId("device-wheel-feedback")).toContainText("Scroll sent");
  await page.waitForTimeout(120);
  expect(actions).toHaveLength(1);
});

test("leaves modifier-assisted browser zoom gestures untouched", async ({ page }) => {
  const actions: Array<Record<string, unknown>> = [];
  await openCockpit(page, actions);
  const canvas = page.getByLabel("Live Android device. Click to tap or drag to swipe.");

  await canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + bounds.width * 0.5,
        clientY: bounds.top + bounds.height * 0.5,
        deltaY: 180,
        deltaMode: 0,
        ctrlKey: true,
      }),
    );
  });

  await page.waitForTimeout(180);
  expect(actions).toHaveLength(0);
  await expect(page.getByTestId("device-wheel-feedback")).toHaveCount(0);
});
