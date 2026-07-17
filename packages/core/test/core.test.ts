import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AndroidActions,
  AndroidService,
  ServeDroidError,
  errorExitCode,
  findElement,
  parseDeviceList,
  parseDisplayInfo,
  parseForeground,
  parseLogLine,
  parseUiHierarchy,
  selectDevice,
  type AdbRunner,
  type DisplayInfo,
  type DeviceSummary,
} from "../src/index.js";

class FakeProcess extends EventEmitter {
  public stdin = new PassThrough();
  public stdout = new PassThrough();
  public stderr = new PassThrough();
  public kill(): boolean {
    this.emit("close", 0);
    return true;
  }
}

class FakeAdb implements AdbRunner {
  public calls: string[][] = [];
  public async run(
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.calls.push([...args]);
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  public async capture(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  public spawn(): never {
    return new FakeProcess() as never;
  }
}

class HierarchyAdb extends FakeAdb {
  public dumps = 0;

  public constructor(
    private readonly foregroundPackages: string[],
    private readonly hierarchyPackages: string[],
  ) {
    super();
  }

  public override async run(
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.calls.push([...args]);
    const command = args.join(" ");
    if (command === "shell wm size")
      return { stdout: "Physical size: 1080x1920", stderr: "", exitCode: 0 };
    if (command === "shell wm density")
      return { stdout: "Physical density: 420", stderr: "", exitCode: 0 };
    if (command === "shell dumpsys input")
      return { stdout: "SurfaceOrientation: 0", stderr: "", exitCode: 0 };
    if (command === "shell dumpsys activity activities") {
      const packageName = this.foregroundPackages.shift() ?? "dev.new";
      return {
        stdout: `mResumedActivity: ActivityRecord{a u0 ${packageName}/.MainActivity t1}`,
        stderr: "",
        exitCode: 0,
      };
    }
    if (args[0] === "shell" && args[1] === "pidof") {
      return { stdout: args[2] === "dev.old" ? "101" : "202", stderr: "", exitCode: 0 };
    }
    if (command === "exec-out uiautomator dump /dev/tty") {
      const packageName = this.hierarchyPackages[this.dumps++] ?? "dev.new";
      return {
        stdout: `<?xml version="1.0"?><hierarchy rotation="0"><node text="Ready" resource-id="${packageName}:id/root" class="android.view.View" package="${packageName}" content-desc="" clickable="false" enabled="true" focusable="false" scrollable="false" selected="false" checked="false" bounds="[0,0][1080,1920]"/></hierarchy>`,
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

const testDevice: DeviceSummary = {
  serial: "emulator-5554",
  state: "device",
  kind: "emulator",
  model: "Pixel",
  product: "sdk",
  manufacturer: "Google",
  apiLevel: 35,
  abi: "x86_64",
};

describe("device parsing and selection", () => {
  const output = `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:1
R58M offline product:beyond model:Galaxy_S10 transport_id:2
USB unauthorized transport_id:3
`;

  it("parses stable adb device fields", () => {
    expect(parseDeviceList(output)).toEqual([
      expect.objectContaining({ serial: "emulator-5554", state: "device", kind: "emulator" }),
      expect.objectContaining({ serial: "R58M", state: "offline", model: "Galaxy S10" }),
      expect.objectContaining({ serial: "USB", state: "unauthorized" }),
    ]);
  });

  it("requires an explicit selector for multiple devices", () => {
    expect(() => selectDevice(parseDeviceList(output))).toThrowError(
      expect.objectContaining({ code: "DEVICE_AMBIGUOUS" }),
    );
  });

  it("surfaces unauthorized devices", () => {
    expect(() => selectDevice(parseDeviceList(output), "USB")).toThrowError(
      expect.objectContaining({ code: "DEVICE_UNAUTHORIZED" }),
    );
  });
});

describe("display and hierarchy", () => {
  const display: DisplayInfo = { width: 1080, height: 1920, density: 420, orientation: "portrait" };

  it("uses override size and density and parses rotation", () => {
    expect(
      parseDisplayInfo(
        "Physical size: 1080x2400\nOverride size: 1080x1920",
        "Physical density: 440\nOverride density: 420",
        "SurfaceOrientation: 1",
      ),
    ).toEqual({ ...display, orientation: "landscape-left" });
  });

  it("normalizes UI bounds and provides stable IDs", () => {
    const xml = `<?xml version="1.0"?><hierarchy rotation="0"><node index="0" text="" resource-id="root" class="android.widget.FrameLayout" package="dev.test" content-desc="" clickable="false" enabled="true" focusable="false" scrollable="false" selected="false" checked="false" bounds="[0,0][1080,1920]"><node index="0" text="Submit" resource-id="dev.test:id/submit" class="android.widget.Button" package="dev.test" content-desc="Submit form" clickable="true" enabled="true" focusable="true" scrollable="false" selected="false" checked="false" bounds="[270,1440][810,1680]"/></node></hierarchy>`;
    const first = parseUiHierarchy(xml, display);
    const second = parseUiHierarchy(xml, display);
    expect(first).toHaveLength(2);
    expect(first[1]).toEqual(
      expect.objectContaining({
        id: second[1]?.id,
        parentId: first[0]?.id,
        text: "Submit",
        resourceId: "dev.test:id/submit",
        clickable: true,
        bounds: { left: 0.25, top: 0.75, right: 0.75, bottom: 0.875 },
      }),
    );
    expect(findElement(first, { text: "Submit" }).id).toBe(first[1]?.id);
    expect(() => findElement(first, { text: "Missing" })).toThrowError(
      expect.objectContaining({ code: "ELEMENT_NOT_FOUND" }),
    );
  });

  it("retries a hierarchy captured across a foreground-app change", async () => {
    const adb = new HierarchyAdb(
      ["dev.old", "dev.new", "dev.new", "dev.new"],
      ["dev.old", "dev.new"],
    );
    const observation = await new AndroidService(adb, testDevice).observe();

    expect(adb.dumps).toBe(2);
    expect(observation.foregroundApp).toMatchObject({ packageName: "dev.new", pid: 202 });
    expect(observation.elements).toEqual([
      expect.objectContaining({ packageName: "dev.new", resourceId: "dev.new:id/root" }),
    ]);
  });

  it("retries a hierarchy whose package lags behind a stable foreground app", async () => {
    const adb = new HierarchyAdb(
      ["dev.new", "dev.new", "dev.new", "dev.new"],
      ["dev.old", "dev.new"],
    );

    const elements = await new AndroidService(adb, testDevice).tree();

    expect(adb.dumps).toBe(2);
    expect(elements[0]).toMatchObject({ packageName: "dev.new" });
  });

  it("rejects a hierarchy when the foreground context never stabilizes", async () => {
    const adb = new HierarchyAdb(
      ["dev.one", "dev.two", "dev.three", "dev.four"],
      ["dev.one", "dev.three"],
    );

    await expect(new AndroidService(adb, testDevice).tree()).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
      details: { attempts: 2 },
    });
    expect(adb.dumps).toBe(2);
  });
});

describe("logs and foreground state", () => {
  it("parses logcat threadtime records", () => {
    expect(parseLogLine("07-17 12:34:56.789  1234  1250 E Fixture: Boom", 7, 2026)).toEqual({
      cursor: "7",
      timestamp: "2026-07-17T12:34:56.789Z",
      pid: 1234,
      tid: 1250,
      priority: "E",
      tag: "Fixture",
      message: "Boom",
    });
    expect(
      parseLogLine(`07-17 12:34:56.789  1234  1250 A ${"  ".repeat(40_000)}`, 8, 2026),
    ).toBeNull();
  });

  it("parses the resumed Android activity", () => {
    expect(
      parseForeground(
        "mResumedActivity: ActivityRecord{abc u0 dev.servedroid.fixture/.MainActivity t12}",
      ),
    ).toEqual({ packageName: "dev.servedroid.fixture", activity: ".MainActivity" });
    expect(
      parseForeground(
        "topResumedActivity=ActivityRecord{def u0 dev.servedroid.fixture/.SecondActivity t13}",
      ),
    ).toEqual({ packageName: "dev.servedroid.fixture", activity: ".SecondActivity" });
    expect(parseForeground("mResumedActivity".repeat(20_000))).toEqual({
      packageName: null,
      activity: null,
    });
  });
});

describe("actions", () => {
  afterEach(() => vi.useRealTimers());

  it("converts normalized taps to pixels", async () => {
    const adb = new FakeAdb();
    const actions = new AndroidActions(adb, "serial", async () => ({
      width: 1000,
      height: 2000,
      density: 400,
      orientation: "portrait",
    }));
    await actions.tap(0.25, 0.75);
    expect(adb.calls[0]).toEqual(["shell", "input", "tap", "250", "1500"]);
  });

  it("rejects invalid coordinates before calling adb", async () => {
    const adb = new FakeAdb();
    const actions = new AndroidActions(adb, "serial", async () => ({
      width: 1,
      height: 1,
      density: null,
      orientation: "portrait",
    }));
    await expect(actions.tap(1.1, 0)).rejects.toBeInstanceOf(ServeDroidError);
    expect(adb.calls).toHaveLength(0);
  });

  it("injects printable ASCII and rejects unsupported Unicode before calling adb", async () => {
    const adb = new FakeAdb();
    const actions = new AndroidActions(adb, "serial", async () => ({
      width: 1,
      height: 1,
      density: null,
      orientation: "portrait",
    }));
    await actions.typeText("hello 100%");
    expect(adb.calls[0]).toEqual(["shell", "input", "text", "hello%s100%25"]);
    await expect(actions.typeText("ciao 👋")).rejects.toThrow("printable ASCII only");
    expect(adb.calls).toHaveLength(1);
  });

  it("waits for fresh display metadata after rotation", async () => {
    vi.useFakeTimers();
    const adb = new FakeAdb();
    let reads = 0;
    const actions = new AndroidActions(adb, "serial", async () => ({
      width: 1000,
      height: 2000,
      density: 400,
      orientation: reads++ === 0 ? "portrait" : "landscape-left",
    }));

    const rotation = actions.rotate("landscape-left");
    await vi.advanceTimersByTimeAsync(100);
    await rotation;

    expect(adb.calls).toEqual([
      ["shell", "settings", "put", "system", "accelerometer_rotation", "0"],
      ["shell", "settings", "put", "system", "user_rotation", "1"],
    ]);
    expect(reads).toBe(2);
  });

  it("fails instead of accepting stale coordinates when rotation never settles", async () => {
    vi.useFakeTimers();
    const adb = new FakeAdb();
    const actions = new AndroidActions(adb, "serial", async () => ({
      width: 1000,
      height: 2000,
      density: 400,
      orientation: "portrait",
    }));

    const rotation = expect(actions.rotate("landscape-right")).rejects.toMatchObject({
      code: "ADB_FAILED",
      details: { orientation: "landscape-right", timeoutMs: 5_000 },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await rotation;
  });
});

describe("public errors", () => {
  it("assigns a stable exit status to occupied ports", () => {
    expect(errorExitCode(new ServeDroidError("PORT_IN_USE", "occupied"))).toBe(31);
  });
});
