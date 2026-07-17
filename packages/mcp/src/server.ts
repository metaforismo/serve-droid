import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AdbClient, AndroidService, listDevices, resolveAdbPath } from "@serve-droid/core";
import { ServeDroidServer } from "@serve-droid/server";
import { z } from "zod";

const Device = z.object({
  device: z.string().optional().describe("ADB serial or unique model name"),
});

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

async function adb() {
  return new AdbClient(await resolveAdbPath());
}

async function service(device?: string): Promise<AndroidService> {
  return AndroidService.connect(await adb(), device);
}

export function createMcpServer() {
  const mcp = new McpServer({ name: "serve-droid", version: "0.1.0" });
  let activeServer: ServeDroidServer | undefined;

  mcp.registerTool(
    "android_list_devices",
    {
      description: "List Android emulators and physical devices visible to ADB.",
      inputSchema: z.object({}),
    },
    async () => text({ schemaVersion: 1, devices: await listDevices(await adb()) }),
  );

  mcp.registerTool(
    "android_start_session",
    {
      description: "Start the authenticated browser cockpit for one Android device.",
      inputSchema: Device,
    },
    async ({ device }) => {
      if (activeServer) await activeServer.stop();
      activeServer = new ServeDroidServer(await service(device));
      const session = await activeServer.start();
      return text({ ...session, token: undefined });
    },
  );

  mcp.registerTool(
    "android_stop_session",
    {
      description: "Stop the Android browser session owned by this MCP process.",
      inputSchema: z.object({}),
    },
    async () => {
      await activeServer?.stop();
      activeServer = undefined;
      return text({ schemaVersion: 1, ok: true });
    },
  );

  mcp.registerTool(
    "android_observe",
    {
      description:
        "Return a screenshot, semantic UI tree, foreground app, display state, and incremental app logs.",
      inputSchema: Device.extend({ logsSince: z.string().default("0") }),
    },
    async ({ device, logsSince }) => {
      const current = await service(device);
      current.startLogs();
      try {
        const [observation, screenshot] = await Promise.all([
          current.observe(logsSince),
          current.screenshot({ width: 1080, quality: 75 }),
        ]);
        return {
          content: [
            { type: "image" as const, data: screenshot.toString("base64"), mimeType: "image/jpeg" },
            { type: "text" as const, text: JSON.stringify(observation) },
          ],
        };
      } finally {
        current.stop();
      }
    },
  );

  mcp.registerTool(
    "android_tap",
    {
      description: "Tap normalized display coordinates from 0 to 1.",
      inputSchema: Device.extend({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
    },
    async ({ device, x, y }) => {
      await (await service(device)).actions.tap(x, y);
      return text({ schemaVersion: 1, ok: true });
    },
  );

  mcp.registerTool(
    "android_swipe",
    {
      description: "Swipe between two normalized display coordinates.",
      inputSchema: Device.extend({
        x1: z.number().min(0).max(1),
        y1: z.number().min(0).max(1),
        x2: z.number().min(0).max(1),
        y2: z.number().min(0).max(1),
        durationMs: z.number().int().min(1).max(60_000).default(300),
      }),
    },
    async ({ device, x1, y1, x2, y2, durationMs }) => {
      await (await service(device)).actions.swipe(x1, y1, x2, y2, durationMs);
      return text({ schemaVersion: 1, ok: true });
    },
  );

  mcp.registerTool(
    "android_type_text",
    {
      description: "Type text into the focused Android field.",
      inputSchema: Device.extend({ text: z.string().min(1) }),
    },
    async ({ device, text: value }) => {
      await (await service(device)).actions.typeText(value);
      return text({ schemaVersion: 1, ok: true });
    },
  );

  mcp.registerTool(
    "android_press_key",
    {
      description: "Press a supported Android hardware or navigation key.",
      inputSchema: Device.extend({
        key: z.enum(["back", "home", "recents", "power", "volume-up", "volume-down", "enter"]),
      }),
    },
    async ({ device, key }) => {
      await (await service(device)).actions.key(key);
      return text({ schemaVersion: 1, ok: true });
    },
  );

  mcp.registerTool(
    "android_manage_app",
    {
      description: "Install, launch, stop, clear, uninstall, or deep-link into an Android app.",
      inputSchema: Device.extend({
        operation: z.enum(["install", "launch", "stop", "clear", "uninstall", "deep-link"]),
        packageName: z.string().optional(),
        path: z.string().optional(),
        activity: z.string().optional(),
        url: z.string().optional(),
        confirm: z.boolean().default(false),
      }),
    },
    async ({ device, operation, packageName = "", path = "", activity, url = "", confirm }) => {
      const actions = (await service(device)).actions;
      if ((operation === "clear" || operation === "uninstall") && !confirm) {
        throw new Error(`${operation} requires confirm=true.`);
      }
      if (operation === "install") await actions.install(path);
      else if (operation === "launch") await actions.launch(packageName, activity);
      else if (operation === "stop") await actions.stop(packageName);
      else if (operation === "clear") await actions.clear(packageName);
      else if (operation === "uninstall") await actions.uninstall(packageName);
      else await actions.deepLink(url, packageName || undefined);
      return text({ schemaVersion: 1, ok: true });
    },
  );

  mcp.registerTool(
    "android_manage_permission",
    {
      description: "Grant, revoke, reset, or inspect a supported Android runtime permission.",
      inputSchema: Device.extend({
        operation: z.enum(["grant", "revoke", "reset", "list"]),
        permission: z.enum([
          "camera",
          "microphone",
          "location",
          "contacts",
          "calendar",
          "notifications",
          "photos",
        ]),
        packageName: z.string().min(1),
      }),
    },
    async ({ device, operation, permission, packageName }) =>
      text({
        schemaVersion: 1,
        output: await (
          await service(device)
        ).actions.permission(operation, permission, packageName),
      }),
  );

  mcp.registerTool(
    "android_push_file",
    {
      description: "Push one local file to a safe /sdcard directory on Android.",
      inputSchema: Device.extend({
        localPath: z.string().min(1),
        remoteDirectory: z.string().default("/sdcard/Download/"),
      }),
    },
    async ({ device, localPath, remoteDirectory }) =>
      text({
        schemaVersion: 1,
        destination: await (await service(device)).actions.push(localPath, remoteDirectory),
      }),
  );

  mcp.registerTool(
    "android_read_logs",
    {
      description:
        "Read bounded incremental Android logs. Start a browser session first for a persistent log cursor.",
      inputSchema: z.object({ since: z.string().default("0") }),
    },
    ({ since }) =>
      Promise.resolve(
        text({
          schemaVersion: 1,
          ...(activeServer?.service.logs.read(since) ?? { entries: [], nextCursor: since }),
        }),
      ),
  );

  return mcp;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
