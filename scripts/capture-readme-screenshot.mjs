/* global Blob, Event, EventTarget, ProgressEvent */
import { chromium } from "@playwright/test";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "docs/assets/serve-droid-cockpit.jpg");

async function availablePort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, reject) =>
    probe.close((error) => (error ? reject(error) : resolveClose())),
  );
  if (!port) throw new Error("Could not allocate a documentation-demo port.");
  return port;
}

const port = await availablePort();
const demo = spawn(process.execPath, [resolve(root, "scripts/demo-server.mjs")], {
  cwd: root,
  env: { ...process.env, SERVE_DROID_DEMO_PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});

const ready = new Promise((resolveReady, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("Documentation demo did not become ready within 10 seconds.")),
    10_000,
  );
  demo.once("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`Documentation demo exited with code ${code}.`));
  });
  demo.stdout.setEncoding("utf8");
  demo.stdout.on("data", (chunk) => {
    if (chunk.includes("serve-droid documentation demo:")) {
      clearTimeout(timeout);
      resolveReady();
    }
  });
});

let browser;
try {
  await ready;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1470, height: 820 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    class DemoXMLHttpRequest extends EventTarget {
      upload = new EventTarget();
      status = 0;
      responseText = "";
      open() {}
      setRequestHeader() {}
      send(body) {
        const total = body instanceof Blob ? body.size : 0;
        globalThis.setTimeout(() => {
          this.upload.dispatchEvent(
            new ProgressEvent("progress", { lengthComputable: true, loaded: total, total }),
          );
          this.upload.dispatchEvent(new Event("load"));
        }, 50);
        globalThis.setTimeout(() => {
          this.status = 200;
          this.responseText = JSON.stringify({ schemaVersion: 1, ok: true, operation: "install" });
          this.dispatchEvent(new Event("load"));
        }, 5_000);
      }
    }
    Object.defineProperty(globalThis, "XMLHttpRequest", {
      configurable: true,
      value: DemoXMLHttpRequest,
    });
  });
  await page.goto(`http://127.0.0.1:${port}/?demo=1`);
  await page.getByText("Demo preview", { exact: true }).waitFor();
  await page.locator(".phone img").waitFor();
  await page.getByText("Session attached to Pixel 9 Pro", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open device clipboard" }).click();
  await page.getByLabel("Text to paste into device").fill("hello from the browser cockpit");
  await page.getByLabel("Choose APK or file").setInputFiles({
    name: "fixture.apk",
    mimeType: "application/vnd.android.package-archive",
    buffer: Buffer.alloc(32 * 1024),
  });
  await page.getByText("Installing fixture.apk on device", { exact: true }).waitFor();
  await page.screenshot({ path: output, type: "jpeg", quality: 88 });
  process.stdout.write(`Updated ${output}\n`);
} finally {
  await browser?.close();
  demo.kill("SIGTERM");
}
