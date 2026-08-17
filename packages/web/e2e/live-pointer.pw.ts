import { expect, test, type Page } from "@playwright/test";

async function openCockpit(
  page: Page,
  actions: Array<Record<string, unknown>>,
  controlMessages: Array<Record<string, unknown>>,
): Promise<void> {
  let controlOpen = false;
  let controlProtocols: string[] = [];

  await page.routeWebSocket("**/api/v1/control", (socket) => {
    controlOpen = true;
    controlProtocols = [...socket.protocols()];
    socket.onMessage((message) => {
      controlMessages.push(JSON.parse(String(message)) as Record<string, unknown>);
      socket.send(JSON.stringify({ schemaVersion: 1, ok: true }));
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

  await page.goto("/#token=browser-test-token");
  await expect(
    page.getByLabel("Live Android device. Click to tap or drag to swipe."),
  ).toBeVisible();
  await expect.poll(() => controlOpen).toBe(true);
  expect(controlProtocols).toEqual(["serve-droid", "token.browser-test-token"]);
}

function phases(messages: Array<Record<string, unknown>>): string[] {
  return messages.flatMap((message) => {
    const gesture = message.gesture as { stream?: { phase?: string } } | undefined;
    return gesture?.stream?.phase ? [gesture.stream.phase] : [];
  });
}

test("forwards drag movement before pointer release without duplicating the HTTP action", async ({
  page,
}) => {
  const actions: Array<Record<string, unknown>> = [];
  const controlMessages: Array<Record<string, unknown>> = [];
  await openCockpit(page, actions, controlMessages);
  const canvas = page.getByLabel("Live Android device. Click to tap or drag to swipe.");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();

  await page.mouse.move(bounds!.x + bounds!.width * 0.35, bounds!.y + bounds!.height * 0.7);
  await page.mouse.down();
  await expect.poll(() => phases(controlMessages)).toContain("begin");

  await page.mouse.move(bounds!.x + bounds!.width * 0.7, bounds!.y + bounds!.height * 0.3, {
    steps: 5,
  });
  await expect.poll(() => phases(controlMessages)).toContain("move");
  expect(actions).toHaveLength(0);

  await page.mouse.up();
  await expect.poll(() => phases(controlMessages)).toContain("end");
  expect(actions).toHaveLength(0);
  await expect(page.getByTestId("live-pointer-feedback")).toContainText("Live drag completed");
});
