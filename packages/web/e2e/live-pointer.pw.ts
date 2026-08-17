import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    __livePointerMessages: Array<Record<string, unknown>>;
    __livePointerControlOpen: boolean;
  }
}

async function openCockpit(page: Page, actions: Array<Record<string, unknown>>): Promise<void> {
  await page.addInitScript(() => {
    const bootstrap = { token: "browser-test-token" };
    Object.defineProperty(globalThis, "__SERVE_DROID_BOOTSTRAP__", {
      configurable: true,
      writable: true,
      value: bootstrap,
    });
    Object.defineProperty(globalThis, "__SERVE_DROID__", {
      configurable: true,
      writable: true,
      value: bootstrap,
    });
    window.__livePointerMessages = [];
    window.__livePointerControlOpen = false;

    class MockWebSocket {
      public static readonly CONNECTING = 0;
      public static readonly OPEN = 1;
      public static readonly CLOSING = 2;
      public static readonly CLOSED = 3;
      public readyState = MockWebSocket.CONNECTING;
      public binaryType: BinaryType = "blob";
      public onopen: ((event: Event) => unknown) | null = null;
      public onmessage: ((event: MessageEvent) => unknown) | null = null;
      public onerror: ((event: Event) => unknown) | null = null;
      public onclose: ((event: CloseEvent) => unknown) | null = null;
      readonly #url: string;

      public constructor(url: string | URL) {
        this.#url = String(url);
        queueMicrotask(() => {
          this.readyState = MockWebSocket.OPEN;
          if (this.#url.endsWith("/api/v1/control")) {
            window.__livePointerControlOpen = true;
          }
          this.onopen?.(new Event("open"));
        });
      }

      public send(value: unknown): void {
        if (!this.#url.endsWith("/api/v1/control") || typeof value !== "string") return;
        window.__livePointerMessages.push(JSON.parse(value) as Record<string, unknown>);
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({ schemaVersion: 1, ok: true }),
            }),
          );
        });
      }

      public close(code = 1000, reason = ""): void {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close", { code, reason }));
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: MockWebSocket,
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

  await page.goto("/");
  await expect(
    page.getByLabel("Live Android device. Click to tap or drag to swipe."),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__livePointerControlOpen)).toBe(true);
}

function phases(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window.__livePointerMessages.flatMap((message) => {
      const gesture = message.gesture as { stream?: { phase?: string } } | undefined;
      return gesture?.stream?.phase ? [gesture.stream.phase] : [];
    }),
  );
}

test("forwards drag movement before pointer release without duplicating the HTTP action", async ({
  page,
}) => {
  const actions: Array<Record<string, unknown>> = [];
  await openCockpit(page, actions);
  const canvas = page.getByLabel("Live Android device. Click to tap or drag to swipe.");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();

  await page.mouse.move(bounds!.x + bounds!.width * 0.35, bounds!.y + bounds!.height * 0.7);
  await page.mouse.down();
  await expect.poll(() => phases(page)).toContain("begin");

  await page.mouse.move(bounds!.x + bounds!.width * 0.7, bounds!.y + bounds!.height * 0.3, {
    steps: 5,
  });
  await expect.poll(() => phases(page)).toContain("move");
  expect(actions).toHaveLength(0);

  await page.mouse.up();
  await expect.poll(() => phases(page)).toContain("end");
  expect(actions).toHaveLength(0);
  await expect(page.getByTestId("live-pointer-feedback")).toContainText("Live drag completed");
});
