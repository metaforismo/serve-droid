import { describe, expect, it } from "vitest";
import { AdbClient, listDevices, resolveAdbPath } from "../src/index.js";

const enabled = process.env.SERVE_DROID_DEVICE_TEST === "1";

describe.skipIf(!enabled)("real Android device", () => {
  it("discovers at least one supported device", async () => {
    const devices = await listDevices(new AdbClient(await resolveAdbPath()));
    expect(
      devices.some((device) => device.state === "device" && (device.apiLevel ?? 0) >= 26),
    ).toBe(true);
  });
});
