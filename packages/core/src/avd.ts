import { spawn, type ChildProcess } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { delimiter, isAbsolute, join, normalize } from "node:path";
import { ServeDroidError } from "./errors.js";

export interface AvdRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface AvdRunner {
  readonly executable: string;
  run(args: readonly string[], options?: { timeoutMs?: number }): Promise<AvdRunResult>;
  spawn(args: readonly string[]): ChildProcess;
}

export interface AvdSummary {
  name: string;
  target: string | null;
  configPath: string | null;
  imagePath: string | null;
  imageAvailable: boolean | null;
}

export interface StartedAvd {
  name: string;
  pid: number;
  headless: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, platform() === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseIni(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*([^#;=]+?)\s*=\s*(.*?)\s*$/u);
    if (match?.[1]) values.set(match[1], match[2] ?? "");
  }
  return values;
}

function sdkRoot(env: NodeJS.ProcessEnv): string | undefined {
  return env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
}

export async function resolveEmulatorPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const executable = platform() === "win32" ? "emulator.exe" : "emulator";
  const candidates: string[] = [];
  for (const root of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (root) candidates.push(join(root, "emulator", executable));
  }
  for (const pathEntry of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    candidates.push(join(pathEntry, executable));
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new ServeDroidError(
    "EMULATOR_NOT_FOUND",
    "Android Emulator was not found. Install it with Android Studio SDK Manager: https://developer.android.com/studio/run/emulator#install",
  );
}

export class EmulatorClient implements AvdRunner {
  public constructor(public readonly executable: string) {}

  public async run(
    args: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<AvdRunResult> {
    const child = spawn(this.executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15_000);
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    }).finally(() => clearTimeout(timer));
    return { stdout, stderr, exitCode };
  }

  public spawn(args: readonly string[]): ChildProcess {
    const child = spawn(this.executable, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return child;
  }
}

export async function listAvds(
  emulator: AvdRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AvdSummary[]> {
  const result = await emulator.run(["-list-avds"]);
  if (result.exitCode !== 0) {
    throw new ServeDroidError(
      "EMULATOR_FAILED",
      result.stderr.trim() || `emulator exited ${result.exitCode}`,
    );
  }
  const names = result.stdout
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter(Boolean);
  const avdHome = env.ANDROID_AVD_HOME ?? join(env.HOME ?? homedir(), ".android", "avd");
  return Promise.all(
    names.map(async (name) => {
      let configPath: string | null = null;
      let target: string | null = null;
      let imagePath: string | null = null;
      let imageAvailable: boolean | null = null;
      try {
        const pointer = parseIni(await readFile(join(avdHome, `${name}.ini`), "utf8"));
        target = pointer.get("target") ?? null;
        const rawConfigPath = pointer.get("path");
        configPath = rawConfigPath
          ? normalize(isAbsolute(rawConfigPath) ? rawConfigPath : join(avdHome, rawConfigPath))
          : join(avdHome, `${name}.avd`);
        const config = parseIni(await readFile(join(configPath, "config.ini"), "utf8"));
        const imageDirectory = config.get("image.sysdir.1");
        const root = sdkRoot(env);
        if (imageDirectory && root) {
          imagePath = normalize(join(root, imageDirectory));
          imageAvailable = await exists(imagePath);
        }
      } catch {
        // The emulator remains authoritative for the AVD list. Inspection is best-effort only.
      }
      return { name, target, configPath, imagePath, imageAvailable };
    }),
  );
}

export async function startAvd(
  emulator: AvdRunner,
  name: string,
  options: {
    env?: NodeJS.ProcessEnv;
    headless?: boolean;
    coldBoot?: boolean;
    wipeData?: boolean;
  } = {},
): Promise<StartedAvd> {
  const avd = (await listAvds(emulator, options.env)).find((candidate) => candidate.name === name);
  if (!avd) throw new ServeDroidError("AVD_NOT_FOUND", `AVD "${name}" is not installed.`);
  if (avd.imageAvailable === false) {
    throw new ServeDroidError(
      "AVD_IMAGE_MISSING",
      `The system image for AVD "${name}" is missing. Install ${avd.target ?? "its configured image"} with Android Studio SDK Manager and accept the Android SDK license there.`,
      { imagePath: avd.imagePath, target: avd.target },
    );
  }
  const args = ["-avd", name];
  if (options.headless) args.push("-no-window", "-no-audio");
  if (options.coldBoot) args.push("-no-snapshot-load");
  if (options.wipeData) args.push("-wipe-data");
  const child = emulator.spawn(args);
  if (!child.pid) throw new ServeDroidError("EMULATOR_FAILED", "Emulator failed to start.");
  return { name, pid: child.pid, headless: options.headless ?? false };
}
