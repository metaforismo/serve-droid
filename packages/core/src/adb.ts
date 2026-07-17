import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { platform } from "node:os";
import { ServeDroidError } from "./errors.js";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface AdbRunner {
  run(
    args: readonly string[],
    options?: { serial?: string; timeoutMs?: number },
  ): Promise<RunResult>;
  capture(
    args: readonly string[],
    options?: { serial?: string; timeoutMs?: number },
  ): Promise<Buffer>;
  spawn(args: readonly string[], options?: { serial?: string }): ChildProcessWithoutNullStreams;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, platform() === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveAdbPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const executable = platform() === "win32" ? "adb.exe" : "adb";
  const candidates: string[] = [];
  for (const root of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (root) candidates.push(join(root, "platform-tools", executable));
  }
  for (const pathEntry of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    candidates.push(join(pathEntry, executable));
  }
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw new ServeDroidError(
    "ADB_NOT_FOUND",
    "Android Platform Tools were not found. Install them from https://developer.android.com/tools/releases/platform-tools and add adb to PATH.",
  );
}

function withSerial(args: readonly string[], serial?: string): string[] {
  return serial ? ["-s", serial, ...args] : [...args];
}

export class AdbClient implements AdbRunner {
  public constructor(public readonly executable: string) {}

  public async run(
    args: readonly string[],
    options: { serial?: string; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    const child = spawn(this.executable, withSerial(args, options.serial), {
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

  public async capture(
    args: readonly string[],
    options: { serial?: string; timeoutMs?: number } = {},
  ): Promise<Buffer> {
    const child = spawn(this.executable, withSerial(args, options.serial), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15_000);
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    }).finally(() => clearTimeout(timer));
    if (exitCode !== 0) {
      throw new ServeDroidError("ADB_FAILED", Buffer.concat(stderr).toString("utf8").trim());
    }
    return Buffer.concat(stdout);
  }

  public spawn(
    args: readonly string[],
    options: { serial?: string } = {},
  ): ChildProcessWithoutNullStreams {
    return spawn(this.executable, withSerial(args, options.serial), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }
}

export async function checkedRun(
  adb: AdbRunner,
  args: readonly string[],
  options: { serial?: string; timeoutMs?: number } = {},
): Promise<string> {
  const result = await adb.run(args, options);
  if (result.exitCode !== 0) {
    throw new ServeDroidError(
      "ADB_FAILED",
      result.stderr.trim() || `adb exited ${result.exitCode}`,
      {
        args,
        serial: options.serial,
      },
    );
  }
  return result.stdout;
}
