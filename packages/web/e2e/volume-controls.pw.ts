import { expect, test, type Page } from "@playwright/test";

const token = "volume-controls-token";

const observation = {
  schemaVersion: 1,
  timestamp: "2026-08-20T14:10:00.000Z",
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

async function routeCockpit(page: Page): Promise<Array<Record<string, unknown>>> {
  const actions: Array<Record<string, unknown>> = [];

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
    route.fulfill({ contentType: "application/json", body: JSON.stringify(observation) }),
  );
  await page.route("**/api/v1/screenshot", async (route) =>
    route.fulfill({ status: 204, contentType: "image/jpeg", body: "" }),
  );
  await page.route("**/api/v1/actions", async (route) => {
    actions.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ schemaVersion: 1, ok: true }),
    });
  });
  await page.routeWebSocket("**/api/v1/video", (socket) => {
    socket.onMessage(() => undefined);
  });
  await page.routeWebSocket("**/api/v1/control", (socket) => {
    socket.onMessage(() => socket.send(JSON.stringify({ schemaVersion: 1, ok: true })));
  });

  return actions;
}

test("volume controls send the existing bounded Android key actions", async ({ page }) => {
  const actions = await routeCockpit(page);
  await page.goto(`/#token=${token}`);

  const volumeDown = page.getByRole("button", { name: "Volume down" });
  const volumeUp = page.getByRole("button", { name: "Volume up" });
  await expect(volumeDown).toBeVisible();
  await expect(volumeUp).toBeVisible();

  await volumeDown.click();
  await volumeUp.click();

  await expect
    .poll(() => actions)
    .toEqual([
      { type: "key", key: "volume-down" },
      { type: "key", key: "volume-up" },
    ]);
  await expect(page.getByText("Volume up sent")).toBeVisible();
});
