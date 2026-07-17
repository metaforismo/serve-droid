import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMcpServer,
  type McpActions,
  type McpAndroidService,
  type McpRuntime,
} from "../src/server.js";
import type { DeviceSummary, SessionInfo, UiElement } from "@serve-droid/core";

const device: DeviceSummary = {
  serial: "emulator-5554",
  state: "device",
  kind: "emulator",
  model: "Pixel_9",
  product: "sdk_gphone64_arm64",
  manufacturer: "Google",
  apiLevel: 35,
  abi: "arm64-v8a",
};

const element: UiElement = {
  id: "element-submit",
  parentId: null,
  className: "android.widget.Button",
  text: "Submit",
  contentDescription: "Submit form",
  resourceId: "dev.servedroid.fixture:id/submit",
  packageName: "dev.servedroid.fixture",
  bounds: { left: 0.2, top: 0.4, right: 0.8, bottom: 0.6 },
  enabled: true,
  clickable: true,
  focusable: true,
  scrollable: false,
  selected: false,
  checked: false,
};

const session: SessionInfo = {
  schemaVersion: 1,
  device,
  display: { width: 1080, height: 1920, density: 420, orientation: "portrait" },
  pid: 123,
  host: "127.0.0.1",
  port: 47321,
  url: "http://127.0.0.1:47321",
  token: "must-not-leak",
  startedAt: "2026-07-17T00:00:00.000Z",
};

interface Fixture {
  runtime: McpRuntime;
  actionCalls: Array<{ name: string; args: unknown[] }>;
  elements: UiElement[];
  serviceCalls: { value: number };
  serviceStops: { value: number };
  logCalls: Array<{ since: string; packageName?: string }>;
  stopped: { value: boolean };
}

function fixture(): Fixture {
  const actionCalls: Array<{ name: string; args: unknown[] }> = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      actionCalls.push({ name, args });
    };
  const actions: McpActions = {
    tap: record("tap"),
    swipe: record("swipe"),
    typeText: record("typeText"),
    key: record("key"),
    install: record("install"),
    launch: record("launch"),
    stop: record("stop"),
    clear: record("clear"),
    uninstall: record("uninstall"),
    deepLink: record("deepLink"),
    permission: async (...args) => {
      actionCalls.push({ name: "permission", args });
      return "permission-output";
    },
    push: async (...args) => {
      actionCalls.push({ name: "push", args });
      return "/sdcard/Download/example.txt";
    },
  };
  const elements = [element];
  const serviceCalls = { value: 0 };
  const serviceStops = { value: 0 };
  const logCalls: Array<{ since: string; packageName?: string }> = [];
  const current: McpAndroidService = {
    actions,
    readLogs: async (since, packageName) => {
      logCalls.push({ since, packageName });
      return {
        entries: [
          {
            cursor: "8",
            timestamp: "2026-07-17T00:00:00.000Z",
            pid: 123,
            tid: 124,
            priority: "I",
            tag: "Fixture",
            message: `after-${since}`,
          },
        ],
        nextCursor: "8",
      };
    },
    startLogs: () => undefined,
    stop: () => {
      serviceStops.value += 1;
    },
    foreground: async () => ({
      packageName: "dev.servedroid.fixture",
      activity: ".MainActivity",
      pid: 123,
    }),
    observe: async (logsSince) => ({
      schemaVersion: 1,
      timestamp: "2026-07-17T00:00:00.000Z",
      device,
      display: session.display,
      foregroundApp: {
        packageName: "dev.servedroid.fixture",
        activity: ".MainActivity",
        pid: 123,
      },
      elements,
      logs: [],
      nextLogCursor: logsSince,
    }),
    screenshot: async () => Buffer.from([1, 2, 3]),
    tree: async () => elements,
  };
  const stopped = { value: false };
  return {
    actionCalls,
    elements,
    serviceCalls,
    serviceStops,
    logCalls,
    stopped,
    runtime: {
      listDevices: async () => [device],
      service: async () => {
        serviceCalls.value += 1;
        return current;
      },
      startSession: async () => ({
        info: session,
        service: current,
        stop: async () => {
          stopped.value = true;
        },
      }),
    },
  };
}

const closeCallbacks: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()));
});

async function connectedClient(runtime: McpRuntime): Promise<Client> {
  const server = createMcpServer(runtime);
  const client = new Client({ name: "serve-droid-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("MCP contracts", () => {
  it("lists and executes every bounded tool over an in-memory transport", async () => {
    const state = fixture();
    const client = await connectedClient(state.runtime);
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name).sort()).toEqual(
      [
        "android_list_devices",
        "android_start_session",
        "android_stop_session",
        "android_observe",
        "android_tap",
        "android_tap_element",
        "android_swipe",
        "android_type_text",
        "android_press_key",
        "android_manage_app",
        "android_manage_permission",
        "android_push_file",
        "android_read_logs",
      ].sort(),
    );

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name} returned an error`).not.toBe(true);
      return result;
    };

    await call("android_list_devices");
    const started = await call("android_start_session", { device: device.serial });
    expect(JSON.stringify(started)).not.toContain(session.token);
    const observed = await call("android_observe", { logsSince: "4" });
    expect(observed.content[0]).toMatchObject({ type: "image", data: "AQID" });
    await call("android_tap", { x: 0.1, y: 0.2 });
    await call("android_tap_element", { selector: { resourceId: element.resourceId } });
    await call("android_swipe", { x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9, durationMs: 350 });
    await call("android_type_text", { text: "hello" });
    await call("android_press_key", { key: "back" });
    await call("android_manage_app", {
      operation: "launch",
      packageName: "dev.servedroid.fixture",
    });
    await call("android_manage_permission", {
      operation: "list",
      permission: "camera",
      packageName: "dev.servedroid.fixture",
    });
    await call("android_push_file", { localPath: "/tmp/example.txt" });
    await call("android_read_logs", { since: "7" });
    await call("android_stop_session");

    expect(state.actionCalls).toContainEqual({ name: "tap", args: [0.5, 0.5] });
    expect(state.serviceCalls.value).toBe(0);
    expect(state.serviceStops.value).toBe(0);
    expect(state.logCalls).toEqual([{ since: "7", packageName: "dev.servedroid.fixture" }]);
    expect(state.stopped.value).toBe(true);
  });

  it("returns ELEMENT_NOT_FOUND and never taps after a failed semantic lookup", async () => {
    const state = fixture();
    const client = await connectedClient(state.runtime);
    const result = await client.callTool({
      name: "android_tap_element",
      arguments: { selector: { text: "Missing" } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("ELEMENT_NOT_FOUND");
    expect(state.actionCalls.filter(({ name }) => name === "tap")).toEqual([]);
  });

  it("returns ELEMENT_AMBIGUOUS and never taps when a selector has multiple matches", async () => {
    const state = fixture();
    state.elements.push({ ...element, id: "element-submit-copy" });
    const client = await connectedClient(state.runtime);
    const result = await client.callTool({
      name: "android_tap_element",
      arguments: { selector: { text: element.text } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("ELEMENT_AMBIGUOUS");
    expect(state.actionCalls.filter(({ name }) => name === "tap")).toEqual([]);
  });

  it("rejects selectors with more than one lookup field before issuing a tap", async () => {
    const state = fixture();
    const client = await connectedClient(state.runtime);
    const result = await client.callTool({
      name: "android_tap_element",
      arguments: {
        selector: { id: element.id, resourceId: element.resourceId },
      },
    });
    expect(result.isError).toBe(true);
    expect(state.actionCalls.filter(({ name }) => name === "tap")).toEqual([]);
  });
});
