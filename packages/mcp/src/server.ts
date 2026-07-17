import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  AdbClient,
  AndroidService,
  ServeDroidError,
  findElement,
  listDevices,
  resolveAdbPath,
  type DeviceSummary,
  type LogEntry,
  type Observation,
  type SessionInfo,
  type UiElement,
} from "@serve-droid/core";
import { ServeDroidServer } from "@serve-droid/server";
import { z } from "zod";

const Device = z.object({
  device: z.string().optional().describe("ADB serial or unique model name"),
});

const ElementTarget = z.union([
  z.object({ id: z.string().min(1) }).strict(),
  z.object({ resourceId: z.string().min(1) }).strict(),
  z.object({ text: z.string().min(1) }).strict(),
  z.object({ contentDescription: z.string().min(1) }).strict(),
]);

type AndroidKey = "back" | "home" | "recents" | "power" | "volume-up" | "volume-down" | "enter";
type PermissionOperation = "grant" | "revoke" | "reset" | "list";

export interface McpActions {
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  typeText(value: string): Promise<void>;
  key(key: AndroidKey): Promise<void>;
  install(path: string): Promise<void>;
  launch(packageName: string, activity?: string): Promise<void>;
  stop(packageName: string): Promise<void>;
  clear(packageName: string): Promise<void>;
  uninstall(packageName: string): Promise<void>;
  deepLink(url: string, packageName?: string): Promise<void>;
  permission(
    operation: PermissionOperation,
    permission: string,
    packageName: string,
  ): Promise<string>;
  push(localPath: string, remoteDirectory: string): Promise<string>;
}

export interface McpAndroidService {
  actions: McpActions;
  logs: { read(since: string): { entries: LogEntry[]; nextCursor: string } };
  startLogs(): void;
  stop(): void;
  observe(logsSince: string): Promise<Omit<Observation, "screenshot">>;
  screenshot(options: { width?: number; quality?: number }): Promise<Buffer>;
  tree(): Promise<UiElement[]>;
}

export interface McpActiveSession {
  info: SessionInfo;
  service: McpAndroidService;
  stop(): Promise<void>;
}

export interface McpRuntime {
  listDevices(): Promise<DeviceSummary[]>;
  service(device?: string): Promise<McpAndroidService>;
  startSession(device?: string): Promise<McpActiveSession>;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function elementError(error: unknown) {
  if (!(error instanceof ServeDroidError)) throw error;
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          schemaVersion: 1,
          error: { code: error.code, message: error.message },
        }),
      },
    ],
  };
}

async function adb() {
  return new AdbClient(await resolveAdbPath());
}

async function service(device?: string): Promise<AndroidService> {
  return AndroidService.connect(await adb(), device);
}

function defaultRuntime(): McpRuntime {
  return {
    listDevices: async () => listDevices(await adb()),
    service,
    startSession: async (device) => {
      const current = await service(device);
      const server = new ServeDroidServer(current);
      return {
        info: await server.start(),
        service: current,
        stop: () => server.stop(),
      };
    },
  };
}

export function createMcpServer(runtime: McpRuntime = defaultRuntime()) {
  const mcp = new McpServer({ name: "serve-droid", version: "0.1.0" });
  let activeSession: McpActiveSession | undefined;
  const selectedService = async (device?: string) => {
    if (
      activeSession &&
      (!device || device.toLowerCase() === activeSession.info.device.serial.toLowerCase())
    ) {
      return { current: activeSession.service, temporary: false };
    }
    return { current: await runtime.service(device), temporary: true };
  };

  mcp.registerTool(
    "android_list_devices",
    {
      description: "List Android emulators and physical devices visible to ADB.",
      inputSchema: z.object({}),
    },
    async () => text({ schemaVersion: 1, devices: await runtime.listDevices() }),
  );

  mcp.registerTool(
    "android_start_session",
    {
      description: "Start the authenticated browser cockpit for one Android device.",
      inputSchema: Device,
    },
    async ({ device }) => {
      await activeSession?.stop();
      activeSession = await runtime.startSession(device);
      return text({ ...activeSession.info, token: undefined });
    },
  );

  mcp.registerTool(
    "android_stop_session",
    {
      description: "Stop the Android browser session owned by this MCP process.",
      inputSchema: z.object({}),
    },
    async () => {
      await activeSession?.stop();
      activeSession = undefined;
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
      const { current, temporary } = await selectedService(device);
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
        if (temporary) current.stop();
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
      await (await selectedService(device)).current.actions.tap(x, y);
      return text({ schemaVersion: 1, ok: true });
    },
  );

  mcp.registerTool(
    "android_tap_element",
    {
      description:
        "Tap the center of one uniquely matched semantic element. Fails on missing or ambiguous matches and never guesses coordinates.",
      inputSchema: Device.extend({ selector: ElementTarget }),
    },
    async ({ device, selector }) => {
      const { current } = await selectedService(device);
      try {
        const element = findElement(await current.tree(), selector);
        const x = (element.bounds.left + element.bounds.right) / 2;
        const y = (element.bounds.top + element.bounds.bottom) / 2;
        await current.actions.tap(x, y);
        return text({
          schemaVersion: 1,
          ok: true,
          elementId: element.id,
          point: { x, y },
        });
      } catch (error) {
        return elementError(error);
      }
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
      await (await selectedService(device)).current.actions.swipe(x1, y1, x2, y2, durationMs);
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
      await (await selectedService(device)).current.actions.typeText(value);
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
      await (await selectedService(device)).current.actions.key(key);
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
      const actions = (await selectedService(device)).current.actions;
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
          await selectedService(device)
        ).current.actions.permission(operation, permission, packageName),
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
        destination: await (
          await selectedService(device)
        ).current.actions.push(localPath, remoteDirectory),
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
          ...(activeSession?.service.logs.read(since) ?? { entries: [], nextCursor: since }),
        }),
      ),
  );

  return mcp;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
