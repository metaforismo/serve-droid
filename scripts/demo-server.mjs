import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import sharp from "sharp";

const host = "127.0.0.1";
const port = Number(process.env.SERVE_DROID_DEMO_PORT ?? 4173);
const webRoot = resolve(import.meta.dirname, "../packages/web/dist");
const token = "documentation-demo-token";

if (!existsSync(resolve(webRoot, "index.html"))) {
  throw new Error("Web build not found. Run `pnpm --filter @serve-droid/web build` first.");
}

const deviceScreen = await sharp(
  Buffer.from(`<svg width="1080" height="2400" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="#18281e"/><stop offset="1" stop-color="#08100b"/></linearGradient></defs>
    <rect width="1080" height="2400" fill="url(#g)"/>
    <text x="72" y="150" fill="#8d9a91" font-family="system-ui" font-size="32">12:42</text>
    <text x="540" y="430" text-anchor="middle" fill="#c7ff4a" font-family="system-ui" font-weight="700" font-size="56">serve-droid fixture</text>
    <text x="540" y="495" text-anchor="middle" fill="#a7b0a9" font-family="system-ui" font-size="30">Human + agent debugging loop</text>
    <rect x="72" y="650" width="936" height="176" rx="32" fill="#202c23" stroke="#445348"/>
    <text x="120" y="720" fill="#8d9a91" font-family="system-ui" font-size="26">MESSAGE</text>
    <text x="120" y="782" fill="#eef3ef" font-family="system-ui" font-size="38">Ready for semantic targeting</text>
    <rect x="72" y="900" width="936" height="144" rx="72" fill="#c7ff4a"/>
    <text x="540" y="990" text-anchor="middle" fill="#142000" font-family="system-ui" font-weight="700" font-size="38">Run verified action</text>
    <text x="72" y="1180" fill="#dfe6e0" font-family="system-ui" font-weight="700" font-size="34">Debug checklist</text>
    <text x="92" y="1260" fill="#b9c3bb" font-family="system-ui" font-size="30">✓ Observe screen and UI hierarchy</text>
    <text x="92" y="1330" fill="#b9c3bb" font-family="system-ui" font-size="30">✓ Target an exact resource ID</text>
    <text x="92" y="1400" fill="#b9c3bb" font-family="system-ui" font-size="30">✓ Verify the result in Logcat</text>
    <rect x="72" y="1550" width="936" height="340" rx="32" fill="#101713" stroke="#303c33"/>
    <text x="120" y="1630" fill="#81c7ff" font-family="monospace" font-size="26">I/FixtureActivity</text>
    <text x="120" y="1690" fill="#cbd3cd" font-family="monospace" font-size="25">Session attached to Pixel 9 Pro</text>
    <text x="120" y="1750" fill="#ffc96b" font-family="monospace" font-size="26">W/AgentLoop</text>
    <text x="120" y="1810" fill="#cbd3cd" font-family="monospace" font-size="25">Waiting for verified action</text>
  </svg>`),
)
  .jpeg({ quality: 88 })
  .toBuffer();

const now = "2026-07-17T12:42:18.420Z";
const observation = {
  schemaVersion: 1,
  timestamp: now,
  device: { serial: "emulator-demo", model: "Pixel 9 Pro", apiLevel: 35, kind: "emulator" },
  display: { width: 1080, height: 2400, orientation: "portrait" },
  foregroundApp: { packageName: "dev.servedroid.fixture", activity: ".MainActivity" },
  screenshot: { mimeType: "image/jpeg", width: 1080, height: 2400, url: "/api/v1/screenshot" },
  elements: [
    {
      id: "el-title",
      parentId: null,
      className: "android.widget.TextView",
      text: "serve-droid fixture",
      contentDescription: "Fixture title",
      resourceId: "dev.servedroid.fixture:id/title",
      bounds: { left: 0.2, top: 0.14, right: 0.8, bottom: 0.2 },
      clickable: false,
      enabled: true,
    },
    {
      id: "el-message",
      parentId: null,
      className: "android.widget.EditText",
      text: "Ready for semantic targeting",
      contentDescription: "Message",
      resourceId: "dev.servedroid.fixture:id/message",
      bounds: { left: 0.067, top: 0.27, right: 0.933, bottom: 0.344 },
      clickable: true,
      enabled: true,
    },
    {
      id: "el-action",
      parentId: null,
      className: "android.widget.Button",
      text: "Run verified action",
      contentDescription: "Run verified action",
      resourceId: "dev.servedroid.fixture:id/run_action",
      bounds: { left: 0.067, top: 0.375, right: 0.933, bottom: 0.435 },
      clickable: true,
      enabled: true,
    },
  ],
  logs: [
    {
      cursor: "1",
      timestamp: now,
      priority: "I",
      tag: "FixtureActivity",
      message: "Session attached to Pixel 9 Pro",
    },
    {
      cursor: "2",
      timestamp: "2026-07-17T12:42:18.620Z",
      priority: "W",
      tag: "AgentLoop",
      message: "Waiting for verified action",
    },
    {
      cursor: "3",
      timestamp: "2026-07-17T12:42:18.820Z",
      priority: "I",
      tag: "ServeDroid",
      message: "UI hierarchy contains 3 targetable elements",
    },
  ],
  nextLogCursor: "3",
};

function json(response, body) {
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname === "/api/v1/observe") {
    const logs = url.searchParams.get("logsSince") === "0" ? observation.logs : [];
    return json(response, { ...observation, logs });
  }
  if (url.pathname === "/api/v1/screenshot") {
    response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
    return response.end(deviceScreen);
  }
  if (url.pathname === "/api/v1/actions" || url.pathname === "/api/v1/files") {
    request.resume();
    return json(response, { schemaVersion: 1, ok: true });
  }

  const file = resolve(webRoot, url.pathname === "/" ? "index.html" : `.${url.pathname}`);
  if (!file.startsWith(webRoot) || !existsSync(file) || !(await stat(file)).isFile()) {
    response.writeHead(404).end();
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
  };
  response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  if (extname(file) === ".html") {
    const html = (await readFile(file, "utf8")).replace(
      "__SERVE_DROID_BOOTSTRAP__",
      JSON.stringify({ token }),
    );
    response.end(html);
  } else createReadStream(file).pipe(response);
});

server.listen(port, host, () => {
  process.stdout.write(`serve-droid documentation demo: http://${host}:${port}/?demo=1\n`);
});
