import type { AdbRunner } from "./adb.js";
import { checkedRun } from "./adb.js";
import { ServeDroidError } from "./errors.js";
import type { DeviceState, DeviceSummary, DisplayInfo, Orientation } from "./types.js";

const DEVICE_STATES = new Set<DeviceState>(["device", "offline", "unauthorized", "unknown"]);

export function parseDeviceList(output: string): DeviceSummary[] {
  return output
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("*"))
    .map((line) => {
      const [serial = "", rawState = "unknown", ...properties] = line.split(/\s+/u);
      const fields = Object.fromEntries(
        properties
          .map((property) => property.split(/:(.*)/su))
          .filter((parts): parts is [string, string] => Boolean(parts[0] && parts[1])),
      );
      const state = DEVICE_STATES.has(rawState as DeviceState)
        ? (rawState as DeviceState)
        : "unknown";
      return {
        serial,
        state,
        kind: fields.transport_id && serial.startsWith("emulator-") ? "emulator" : "physical",
        model: fields.model?.replaceAll("_", " ") ?? null,
        product: fields.product ?? null,
        manufacturer: null,
        apiLevel: null,
        abi: null,
      } satisfies DeviceSummary;
    });
}

export async function listDevices(adb: AdbRunner): Promise<DeviceSummary[]> {
  const devices = parseDeviceList(await checkedRun(adb, ["devices", "-l"]));
  return Promise.all(
    devices.map(async (device) => {
      if (device.state !== "device") return device;
      const [api, manufacturer, abi, qemu] = await Promise.all([
        checkedRun(adb, ["shell", "getprop", "ro.build.version.sdk"], { serial: device.serial }),
        checkedRun(adb, ["shell", "getprop", "ro.product.manufacturer"], { serial: device.serial }),
        checkedRun(adb, ["shell", "getprop", "ro.product.cpu.abi"], { serial: device.serial }),
        checkedRun(adb, ["shell", "getprop", "ro.kernel.qemu"], { serial: device.serial }),
      ]);
      return {
        ...device,
        kind: qemu.trim() === "1" ? "emulator" : "physical",
        apiLevel: Number.parseInt(api.trim(), 10) || null,
        manufacturer: manufacturer.trim() || null,
        abi: abi.trim() || null,
      };
    }),
  );
}

export function selectDevice(devices: readonly DeviceSummary[], selector?: string): DeviceSummary {
  if (!selector) {
    if (devices.length === 1) return validateDevice(devices[0]!);
    if (devices.length === 0)
      throw new ServeDroidError("DEVICE_NOT_FOUND", "No ADB devices found.");
    throw new ServeDroidError("DEVICE_AMBIGUOUS", "Multiple devices found; pass --device.", {
      devices: devices.map(({ serial, model }) => ({ serial, model })),
    });
  }
  const needle = selector.toLocaleLowerCase();
  const matches = devices.filter(
    (device) =>
      device.serial.toLocaleLowerCase() === needle || device.model?.toLocaleLowerCase() === needle,
  );
  if (matches.length === 0) {
    throw new ServeDroidError("DEVICE_NOT_FOUND", `Device '${selector}' was not found.`);
  }
  if (matches.length > 1) {
    throw new ServeDroidError("DEVICE_AMBIGUOUS", `Device selector '${selector}' is ambiguous.`);
  }
  return validateDevice(matches[0]!);
}

function validateDevice(device: DeviceSummary): DeviceSummary {
  if (device.state === "unauthorized") {
    throw new ServeDroidError(
      "DEVICE_UNAUTHORIZED",
      `Authorize USB debugging on ${device.serial}.`,
    );
  }
  if (device.state !== "device") {
    throw new ServeDroidError("DEVICE_OFFLINE", `Device ${device.serial} is ${device.state}.`);
  }
  if (device.apiLevel !== null && device.apiLevel < 26) {
    throw new ServeDroidError(
      "UNSUPPORTED_ANDROID",
      `Android API ${device.apiLevel} is unsupported; serve-droid requires API 26+.`,
    );
  }
  return device;
}

export function parseDisplayInfo(
  sizeOutput: string,
  densityOutput: string,
  rotationOutput: string,
): DisplayInfo {
  const sizeMatches = [...sizeOutput.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/gu)];
  const lastSize = sizeMatches.at(-1);
  if (!lastSize) throw new ServeDroidError("ADB_FAILED", "Could not determine display size.");
  const width = Number(lastSize[1]);
  const height = Number(lastSize[2]);
  const densityMatches = [...densityOutput.matchAll(/(?:Physical|Override) density:\s*(\d+)/gu)];
  const density = Number(densityMatches.at(-1)?.[1]) || null;
  const rotationValue = Number(
    rotationOutput.match(
      /(?:SurfaceOrientation|mCurrentOrientation|rotation)\s*[:=]\s*(\d)/iu,
    )?.[1] ?? 0,
  );
  const orientation: Orientation =
    rotationValue === 1 ? "landscape-left" : rotationValue === 3 ? "landscape-right" : "portrait";
  return { width, height, density, orientation };
}

export async function getDisplayInfo(adb: AdbRunner, serial: string): Promise<DisplayInfo> {
  const [size, density, rotation] = await Promise.all([
    checkedRun(adb, ["shell", "wm", "size"], { serial }),
    checkedRun(adb, ["shell", "wm", "density"], { serial }),
    checkedRun(adb, ["shell", "dumpsys", "input"], { serial }),
  ]);
  return parseDisplayInfo(size, density, rotation);
}
