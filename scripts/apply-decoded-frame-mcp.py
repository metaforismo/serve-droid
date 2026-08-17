from pathlib import Path


def replace_once(path_name: str, old: str, new: str, label: str) -> None:
    path = Path(path_name)
    content = path.read_text(encoding="utf-8")
    if new in content:
        return
    if old not in content:
        raise SystemExit(f"{label} marker was not found in {path_name}")
    path.write_text(content.replace(old, new, 1), encoding="utf-8")


replace_once(
    "packages/mcp/src/server.ts",
    'import { ServeDroidServer } from "@serve-droid/server";\n',
    '''import {
  ServeDroidServer,
  type AgentScreenshot,
  type AgentScreenshotOptions,
} from "@serve-droid/server";
''',
    "MCP screenshot imports",
)
replace_once(
    "packages/mcp/src/server.ts",
    '''export interface McpActiveSession {
  info: SessionInfo;
  service: McpAndroidService;
  stop(): Promise<void>;
}''',
    '''export interface McpActiveSession {
  info: SessionInfo;
  service: McpAndroidService;
  captureScreenshot(options: AgentScreenshotOptions): Promise<AgentScreenshot>;
  stop(): Promise<void>;
}''',
    "active session screenshot interface",
)
replace_once(
    "packages/mcp/src/server.ts",
    '''        info: await server.start(),
        service: current,
        stop: () => server.stop(),''',
    '''        info: await server.start(),
        service: current,
        captureScreenshot: (options) => server.captureAgentScreenshot(options),
        stop: () => server.stop(),''',
    "default runtime capture",
)
replace_once(
    "packages/mcp/src/server.ts",
    '''      return { current: activeSession.service, temporary: false };
    }
    return { current: await runtime.service(device), temporary: true };''',
    '''      return {
        current: activeSession.service,
        temporary: false,
        captureScreenshot: (options: AgentScreenshotOptions) =>
          activeSession.captureScreenshot(options),
      };
    }
    const current = await runtime.service(device);
    return {
      current,
      temporary: true,
      captureScreenshot: async (options: AgentScreenshotOptions): Promise<AgentScreenshot> => ({
        data: await current.screenshot(options),
        mimeType: "image/jpeg",
        source: "device",
        width: null,
        height: null,
        capturedAt: new Date().toISOString(),
      }),
    };''',
    "selected screenshot source",
)
replace_once(
    "packages/mcp/src/server.ts",
    '''      const { current, temporary } = await selectedService(device);
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
        };''',
    '''      const { current, temporary, captureScreenshot } = await selectedService(device);
      current.startLogs();
      try {
        const [observation, screenshot] = await Promise.all([
          current.observe(logsSince),
          captureScreenshot({ width: 1080, quality: 75 }),
        ]);
        return {
          content: [
            {
              type: "image" as const,
              data: screenshot.data.toString("base64"),
              mimeType: screenshot.mimeType,
            },
            {
              type: "text" as const,
              text: JSON.stringify({
                ...observation,
                screenshot: {
                  source: screenshot.source,
                  width: screenshot.width,
                  height: screenshot.height,
                  capturedAt: screenshot.capturedAt,
                },
              }),
            },
          ],
        };''',
    "MCP observe screenshot",
)
replace_once(
    "packages/mcp/test/server.test.ts",
    '''        service: current,
        stop: async () => {
          stopped.value = true;
        },''',
    '''        service: current,
        captureScreenshot: async () => ({
          data: Buffer.from([4, 5, 6]),
          mimeType: "image/jpeg",
          source: "stream",
          width: 3,
          height: 2,
          capturedAt: "2026-07-17T00:00:01.000Z",
        }),
        stop: async () => {
          stopped.value = true;
        },''',
    "MCP fixture capture",
)
replace_once(
    "packages/mcp/test/server.test.ts",
    '    expect(observed.content[0]).toMatchObject({ type: "image", data: "AQID" });',
    '''    expect(observed.content[0]).toMatchObject({ type: "image", data: "BAUG" });
    expect(observed.content[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"source":"stream"'),
    });''',
    "MCP active screenshot expectation",
)

path = Path("packages/mcp/test/server.test.ts")
content = path.read_text(encoding="utf-8")
marker = '  it("returns ELEMENT_NOT_FOUND and never taps after a failed semantic lookup", async () => {'
extra = '''  it("uses the ADB screenshot path when no browser session is active", async () => {
    const state = fixture();
    const client = await connectedClient(state.runtime);
    const observed = await client.callTool({
      name: "android_observe",
      arguments: { logsSince: "0" },
    });
    expect(observed.isError).not.toBe(true);
    expect(observed.content[0]).toMatchObject({ type: "image", data: "AQID" });
    expect(observed.content[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"source":"device"'),
    });
    expect(state.serviceCalls.value).toBe(1);
    expect(state.serviceStops.value).toBe(1);
  });

'''
if 'it("uses the ADB screenshot path when no browser session is active"' not in content:
    if marker not in content:
        raise SystemExit("MCP fallback test marker was not found")
    path.write_text(content.replace(marker, extra + marker, 1), encoding="utf-8")
