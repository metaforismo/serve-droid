import { expect, test } from "@playwright/test";
import { probeBrowser } from "../../cli/src/browser-probe.js";

test("reports the real browser capabilities through the one-time loopback probe", async ({
  page,
}) => {
  let probeUrl: string | undefined;
  const resultPromise = probeBrowser({
    timeoutMs: 10_000,
    launch: (url) => {
      probeUrl = url;
    },
  });

  await expect.poll(() => probeUrl).toBeTruthy();
  const response = await page.goto(probeUrl!);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toBe("no-store");
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'none'");

  const result = await resultPromise;
  expect(result.capabilities.userAgent.length).toBeGreaterThan(0);
  expect(result.capabilities.secureContext).toBe(true);
  expect(result.control).toBe(true);
  expect(result.decoder).not.toBe("unavailable");
  expect(result.ready).toBe(true);
  await expect(page.getByRole("status")).toHaveText("Probe complete. You may close this tab.");
});
