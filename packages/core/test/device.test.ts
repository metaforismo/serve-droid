import { describe, expect, it } from "vitest";
import {
  AdbClient,
  AndroidService,
  findElement,
  listDevices,
  resolveAdbPath,
  ServeDroidError,
  type ElementSelector,
  type UiElement,
} from "../src/index.js";

const enabled = process.env.SERVE_DROID_DEVICE_TEST === "1";
const fixtureApk = process.env.SERVE_DROID_FIXTURE_APK;
const FIXTURE_PACKAGE = "dev.servedroid.fixture";
const POLL_INTERVAL_MS = 200;

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}.${suffix}`);
}

function hasTappableBounds(element: UiElement): boolean {
  return element.bounds.right > element.bounds.left && element.bounds.bottom > element.bounds.top;
}

async function tapElement(service: AndroidService, element: UiElement): Promise<void> {
  if (!hasTappableBounds(element)) {
    throw new Error(
      `Element '${element.resourceId || element.text}' has no tappable visible bounds.`,
    );
  }
  await service.actions.tap(
    (element.bounds.left + element.bounds.right) / 2,
    (element.bounds.top + element.bounds.bottom) / 2,
  );
}

function lookup(elements: readonly UiElement[], selector: ElementSelector): UiElement | null {
  try {
    return findElement(elements, selector);
  } catch (error) {
    if (error instanceof ServeDroidError && error.code === "ELEMENT_NOT_FOUND") return null;
    throw error;
  }
}

async function findTappableElement(
  service: AndroidService,
  selector: ElementSelector,
  maxScrolls = 4,
): Promise<UiElement> {
  for (let attempt = 0; attempt <= maxScrolls; attempt += 1) {
    const elements = await service.tree();
    const element = lookup(elements, selector);
    if (element && hasTappableBounds(element)) return element;
    if (attempt === maxScrolls) break;

    const scrollable = elements.find(
      (candidate) => candidate.scrollable && hasTappableBounds(candidate),
    );
    if (!scrollable) {
      throw new Error(
        "The requested fixture element is not visible and no semantic scroll container exists.",
      );
    }
    const height = scrollable.bounds.bottom - scrollable.bounds.top;
    const x = (scrollable.bounds.left + scrollable.bounds.right) / 2;
    await service.actions.swipe(
      x,
      scrollable.bounds.bottom - height * 0.15,
      x,
      scrollable.bounds.top + height * 0.15,
      350,
    );
  }
  throw new Error(
    "The requested fixture element did not become tappable after bounded semantic scrolling.",
  );
}

describe.skipIf(!enabled)("real Android device", () => {
  it("discovers at least one supported device", async () => {
    const devices = await listDevices(new AdbClient(await resolveAdbPath()));
    expect(
      devices.some((device) => device.state === "device" && (device.apiLevel ?? 0) >= 26),
    ).toBe(true);
  });

  it.skipIf(!fixtureApk)(
    "installs, observes, acts, captures a crash, and relaunches the fixture",
    async () => {
      const adb = new AdbClient(await resolveAdbPath());
      const service = await AndroidService.connect(adb);
      let installed = false;
      try {
        await service.actions.install(fixtureApk!);
        installed = true;
        service.startLogs();
        await service.actions.launch(FIXTURE_PACKAGE);

        await waitFor(
          () => service.foreground(),
          (foreground) => foreground.packageName === FIXTURE_PACKAGE,
          "the fixture to enter the foreground",
        );

        const initial = await waitFor(
          () => service.observe(),
          (observation) =>
            observation.foregroundApp.packageName === FIXTURE_PACKAGE &&
            observation.elements.some((element) => element.text === "serve-droid fixture"),
          "a stable initial fixture observation",
        );
        expect(initial.schemaVersion).toBe(1);

        const input = findElement(initial.elements, {
          resourceId: `${FIXTURE_PACKAGE}:id/name_input`,
        });
        await tapElement(service, input);
        await service.actions.typeText("Ada");

        const submit = await findTappableElement(service, {
          contentDescription: "Submit fixture form",
        });
        await tapElement(service, submit);

        await waitFor(
          () => service.observe(),
          (observation) =>
            observation.elements.some((element) => element.text === "Submitted for Ada"),
          "the submitted fixture state",
        );

        const beforeCrash = service.logs.read("0").nextCursor;
        const crash = await findTappableElement(service, {
          contentDescription: "Trigger intentional fixture crash",
        });
        await tapElement(service, crash);

        const crashEntries = await waitFor(
          async () => service.logs.read(beforeCrash).entries,
          (entries) =>
            entries.some(
              (entry) =>
                entry.tag === "ServeDroidFixture" &&
                entry.message.includes("Intentional fixture crash requested"),
            ) &&
            entries.some(
              (entry) =>
                entry.tag === "AndroidRuntime" && entry.message.includes("FATAL EXCEPTION"),
            ),
          "the intentional crash evidence in Logcat",
          10_000,
        );
        expect(
          crashEntries.some(
            (entry) =>
              entry.tag === "ServeDroidFixture" &&
              entry.message.includes("Intentional fixture crash requested"),
          ),
        ).toBe(true);

        await service.actions.launch(FIXTURE_PACKAGE);
        const relaunched = await waitFor(
          () => service.observe(),
          (observation) =>
            observation.foregroundApp.packageName === FIXTURE_PACKAGE &&
            observation.elements.some((element) => element.text === "Waiting for submission"),
          "the fixture to relaunch into a fresh observable state",
        );
        expect(relaunched.foregroundApp.packageName).toBe(FIXTURE_PACKAGE);
      } finally {
        service.stop();
        if (installed) {
          await service.actions.uninstall(FIXTURE_PACKAGE).catch(() => undefined);
        }
      }
    },
    120_000,
  );
});
