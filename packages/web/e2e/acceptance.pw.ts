import { expect, test, type Page } from "@playwright/test";

const token = "acceptance-token";

const observation = {
  schemaVersion: 1,
  timestamp: "2026-08-17T19:40:00.000Z",
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

async function routeCockpitHttp(
  page: Page,
  onObserve: ((authorization: string) => void) | undefined = undefined,
): Promise<void> {
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
  await page.route("**/api/v1/observe?**", async (route) => {
    onObserve?.(route.request().headers().authorization ?? "");
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(observation) });
  });
  await page.route("**/api/v1/screenshot", async (route) =>
    route.fulfill({ status: 204, contentType: "image/jpeg", body: "" }),
  );
}

async function routeVideo(page: Page, onConnect: (protocols: string[], url: string) => void = () => undefined) {
  await page.routeWebSocket("**/api/v1/video", (socket) => {
    onConnect([...socket.protocols()], socket.url());
    socket.onMessage(() => undefined);
  });
}

async function routeStableControl(page: Page): Promise<void> {
  await page.routeWebSocket("**/api/v1/control", (socket) => {
    socket.onMessage(() => socket.send(JSON.stringify({ schemaVersion: 1, ok: true })));
  });
}

test("auth rejects malformed tokens and keeps the accepted token out of URLs", async ({ page }) => {
  let authorization = "";
  let videoProtocols: string[] = [];
  let videoUrl = "";
  await routeCockpitHttp(page, (value) => {
    authorization = value;
  });
  await routeVideo(page, (protocols, url) => {
    videoProtocols = protocols;
    videoUrl = url;
  });
  await routeStableControl(page);

  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Session token" });
  await expect(input).toBeVisible();
  await input.fill("two words");
  await page.getByRole("button", { name: "Connect to device" }).click();
  await expect(page.getByRole("alert")).toContainText("Enter the session token exactly");
  await expect(page.getByRole("heading", { name: "Enter the session token" })).toBeVisible();

  await input.fill(token);
  await page.getByRole("button", { name: "Connect to device" }).click();
  await expect(page.locator(".topbar")).toContainText("serve-droid");
  await expect.poll(() => authorization).toBe(`Bearer ${token}`);
  await expect.poll(() => videoProtocols).toEqual(["serve-droid", `token.${token}`]);
  expect(videoUrl).not.toContain(token);
  await expect(page).not.toHaveURL(/token=/u);
  expect(page.url()).not.toContain(token);
});

test("visible cockpit controls have accessible names and keyboard focus", async ({ page }) => {
  await routeCockpitHttp(page);
  await routeVideo(page);
  await routeStableControl(page);
  await page.goto(`/#token=${token}`);
  await expect(page.getByLabel("Device controls")).toBeVisible();

  const interactive = page.locator(
    "button:visible, input:visible, select:visible, textarea:visible",
  );
  const count = await interactive.count();
  expect(count).toBeGreaterThan(8);
  for (let index = 0; index < count; index += 1) {
    await expect(interactive.nth(index)).toHaveAccessibleName(/\S/u);
  }

  await expect(page.getByRole("tablist")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Logcat/u })).toHaveAttribute("aria-selected", "true");
  expect(await page.locator('[aria-live="polite"]').count()).toBeGreaterThan(0);

  await page.keyboard.press("Tab");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName ?? ""))
    .not.toBe("BODY");
});

test("file upload preserves bearer auth, raw bytes, and the visible completion state", async ({
  page,
}) => {
  let authorization = "";
  let fileName = "";
  let contentType = "";
  let bytes = -1;
  await routeCockpitHttp(page);
  await routeVideo(page);
  await routeStableControl(page);
  await page.route("**/api/v1/files", async (route) => {
    const headers = route.request().headers();
    authorization = headers.authorization ?? "";
    fileName = decodeURIComponent(headers["x-file-name"] ?? "");
    contentType = headers["content-type"] ?? "";
    bytes = route.request().postDataBuffer()?.length ?? 0;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        ok: true,
        operation: "push",
        destination: "/sdcard/Download/notes.txt",
      }),
    });
  });

  await page.goto(`/#token=${token}`);
  const payload = Buffer.from("browser acceptance upload\n", "utf8");
  await page.getByLabel("Choose APK or file").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: payload,
  });

  await expect(page.getByRole("status").filter({ hasText: "Pushed notes.txt to Downloads" })).toContainText(
    "Done",
  );
  expect(authorization).toBe(`Bearer ${token}`);
  expect(fileName).toBe("notes.txt");
  expect(contentType).toBe("application/octet-stream");
  expect(bytes).toBe(payload.length);
});

test("live pointer control reconnects after a forced socket failure", async ({ page }) => {
  const actions: Array<Record<string, unknown>> = [];
  const messages = new Map<number, Array<Record<string, unknown>>>();
  let connections = 0;

  await routeCockpitHttp(page);
  await routeVideo(page);
  await page.route("**/api/v1/actions", async (route) => {
    actions.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ schemaVersion: 1, ok: true }),
    });
  });
  await page.routeWebSocket("**/api/v1/control", (socket) => {
    connections += 1;
    const connection = connections;
    const received: Array<Record<string, unknown>> = [];
    messages.set(connection, received);
    socket.onMessage((message) => {
      received.push(JSON.parse(String(message)) as Record<string, unknown>);
      socket.send(JSON.stringify({ schemaVersion: 1, ok: true }));
    });
    if (connection === 1) {
      setTimeout(() => {
        void socket.close({ code: 1011, reason: "acceptance reconnect" });
      }, 75);
    }
  });

  await page.goto(`/#token=${token}`);
  await expect.poll(() => connections, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(100);

  const canvas = page.getByLabel("Live Android device. Click to tap or drag to swipe.");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width * 0.4, bounds!.y + bounds!.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.65, bounds!.y + bounds!.height * 0.35, {
    steps: 4,
  });
  await page.mouse.up();

  const phases = () =>
    (messages.get(2) ?? []).flatMap((message) => {
      const gesture = message.gesture as { stream?: { phase?: string } } | undefined;
      return gesture?.stream?.phase ? [gesture.stream.phase] : [];
    });
  await expect.poll(phases).toContain("begin");
  await expect.poll(phases).toContain("end");
  expect(actions).toHaveLength(0);
  await expect(page.getByTestId("live-pointer-feedback")).toContainText("Live drag completed");
});
