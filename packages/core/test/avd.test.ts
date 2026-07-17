import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listAvds,
  startAvd,
  type AvdRunner,
  type AvdRunResult,
  type ServeDroidError,
} from "../src/index.js";

class FakeEmulator implements AvdRunner {
  public readonly executable = "emulator";
  public readonly calls: string[][] = [];
  public constructor(public output = "Pixel_8\n") {}
  public async run(args: readonly string[]): Promise<AvdRunResult> {
    this.calls.push([...args]);
    return { stdout: this.output, stderr: "", exitCode: 0 };
  }
  public spawn(args: readonly string[]): never {
    this.calls.push([...args]);
    return Object.assign(new EventEmitter(), { pid: 4242 }) as never;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture(imageExists: boolean) {
  const root = await mkdtemp(join(tmpdir(), "serve-droid-avd-test-"));
  temporaryDirectories.push(root);
  const sdk = join(root, "sdk");
  const home = join(root, "avd");
  const config = join(home, "Pixel_8.avd");
  await mkdir(config, { recursive: true });
  await writeFile(join(home, "Pixel_8.ini"), `path=${config}\ntarget=android-35\n`, "utf8");
  await writeFile(
    join(config, "config.ini"),
    "image.sysdir.1=system-images/android-35/google_apis/arm64-v8a\n",
    "utf8",
  );
  if (imageExists) {
    await mkdir(join(sdk, "system-images", "android-35", "google_apis", "arm64-v8a"), {
      recursive: true,
    });
  }
  return { ANDROID_HOME: sdk, ANDROID_AVD_HOME: home, HOME: root, PATH: "" };
}

describe("AVD discovery and lifecycle", () => {
  it("lists installed AVDs with their configured image state", async () => {
    const avds = await listAvds(new FakeEmulator(), await fixture(true));
    expect(avds).toEqual([
      expect.objectContaining({
        name: "Pixel_8",
        target: "android-35",
        imageAvailable: true,
      }),
    ]);
  });

  it("starts only an explicitly named installed AVD", async () => {
    const emulator = new FakeEmulator();
    await expect(
      startAvd(emulator, "Pixel_8", {
        env: await fixture(true),
        headless: true,
        coldBoot: true,
      }),
    ).resolves.toEqual({ name: "Pixel_8", pid: 4242, headless: true });
    expect(emulator.calls.at(-1)).toEqual([
      "-avd",
      "Pixel_8",
      "-no-window",
      "-no-audio",
      "-no-snapshot-load",
    ]);
  });

  it("reports a missing system image before spawning the emulator", async () => {
    const emulator = new FakeEmulator();
    await expect(startAvd(emulator, "Pixel_8", { env: await fixture(false) })).rejects.toEqual(
      expect.objectContaining<Partial<ServeDroidError>>({ code: "AVD_IMAGE_MISSING" }),
    );
    expect(emulator.calls).toHaveLength(1);
  });

  it("rejects unknown names without guessing", async () => {
    await expect(
      startAvd(new FakeEmulator(), "Pixel_9", { env: await fixture(true) }),
    ).rejects.toEqual(expect.objectContaining<Partial<ServeDroidError>>({ code: "AVD_NOT_FOUND" }));
  });
});
