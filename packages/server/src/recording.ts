import { randomUUID } from "node:crypto";
import { open, readFile, readdir, rename, lstat, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { SCHEMA_VERSION, ServeDroidError } from "@serve-droid/core";

export type RecordingStopReason = "active" | "completed" | "size-limit" | "time-limit";

export interface RecordingOptions {
  directory: string;
  serial: string;
  maxBytes: number;
  maxDurationMs: number;
}

export interface RecordingStatus {
  schemaVersion: typeof SCHEMA_VERSION;
  active: boolean;
  directory: string;
  startedAt: string;
  bytesWritten: number;
  maxBytes: number;
  maxDurationMs: number;
  reason: RecordingStopReason;
}

interface RecordingManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  pid: number;
  serial: string;
  startedAt: string;
  endedAt: string | null;
  status: RecordingStopReason | "crashed";
  bytesWritten: number;
  maxBytes: number;
  maxDurationMs: number;
  video: { path: "video.h264"; codec: "h264-annex-b" };
  events: { path: "events.jsonl"; format: "jsonl"; containsLogs: false };
}

function safeSerial(serial: string): string {
  return serial.replaceAll(/[^a-zA-Z0-9_.-]/gu, "_");
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function recoverPartialRecordings(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const recovered: string[] = [];
  for (const entry of entries) {
    const directory = join(root, entry);
    const partial = join(directory, "manifest.partial.json");
    try {
      if (!(await lstat(directory)).isDirectory()) continue;
      const manifest = JSON.parse(await readFile(partial, "utf8")) as RecordingManifest;
      if (processIsAlive(manifest.pid)) continue;
      const crashed: RecordingManifest = {
        ...manifest,
        endedAt: new Date().toISOString(),
        status: "crashed",
      };
      const target = join(directory, "manifest.crashed.json");
      await writeFile(partial, `${JSON.stringify(crashed, null, 2)}\n`, { mode: 0o600 });
      await rename(partial, target);
      recovered.push(target);
    } catch {
      // Ignore unrelated directories and malformed user-owned files.
    }
  }
  return recovered;
}

export async function removeRecording(directory: string): Promise<void> {
  const target = resolve(directory);
  let manifest: RecordingManifest | undefined;
  for (const name of ["manifest.json", "manifest.crashed.json", "manifest.partial.json"]) {
    try {
      manifest = JSON.parse(await readFile(join(target, name), "utf8")) as RecordingManifest;
      break;
    } catch {
      // Try the next recognized manifest name.
    }
  }
  if (
    !manifest ||
    manifest.schemaVersion !== SCHEMA_VERSION ||
    !manifest.video ||
    !manifest.events
  ) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      "Refusing to remove a directory that is not a serve-droid recording.",
    );
  }
  if (manifest.status === "active" && processIsAlive(manifest.pid)) {
    throw new ServeDroidError("INVALID_ARGUMENT", "Refusing to remove an active recording.");
  }
  await rm(target, { recursive: true, force: false });
}

export class SessionRecorder {
  readonly #manifest: RecordingManifest;
  readonly #video: FileHandle;
  readonly #events: FileHandle;
  readonly #partialManifestPath: string;
  readonly #directory: string;
  readonly #timer: NodeJS.Timeout;
  #queue: Promise<void> = Promise.resolve();
  #active = true;
  #finalized = false;
  #reason: RecordingStopReason = "active";
  #bytesWritten = 0;

  private constructor(
    private readonly options: RecordingOptions,
    directory: string,
    video: FileHandle,
    events: FileHandle,
    manifest: RecordingManifest,
  ) {
    this.#video = video;
    this.#events = events;
    this.#manifest = manifest;
    this.#directory = directory;
    this.#partialManifestPath = join(directory, "manifest.partial.json");
    this.#timer = setTimeout(() => this.#reachLimit("time-limit"), options.maxDurationMs);
    this.#timer.unref();
  }

  public static async create(options: RecordingOptions): Promise<SessionRecorder> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1024 * 1024) {
      throw new ServeDroidError("INVALID_ARGUMENT", "Recording maxBytes must be at least 1 MiB.");
    }
    if (!Number.isSafeInteger(options.maxDurationMs) || options.maxDurationMs < 1_000) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "Recording maxDurationMs must be at least 1 second.",
      );
    }
    const root = resolve(options.directory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await recoverPartialRecordings(root);
    const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
    const directory = join(
      root,
      `session-${safeSerial(options.serial)}-${timestamp}-${randomUUID().slice(0, 8)}`,
    );
    await mkdir(directory, { mode: 0o700 });
    const video = await open(join(directory, "video.h264"), "wx", 0o600);
    const events = await open(join(directory, "events.jsonl"), "wx", 0o600);
    const startedAt = new Date().toISOString();
    const manifest: RecordingManifest = {
      schemaVersion: SCHEMA_VERSION,
      pid: process.pid,
      serial: options.serial,
      startedAt,
      endedAt: null,
      status: "active",
      bytesWritten: 0,
      maxBytes: options.maxBytes,
      maxDurationMs: options.maxDurationMs,
      video: { path: "video.h264", codec: "h264-annex-b" },
      events: { path: "events.jsonl", format: "jsonl", containsLogs: false },
    };
    await writeFile(
      join(directory, "manifest.partial.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    return new SessionRecorder(options, directory, video, events, manifest);
  }

  public get status(): RecordingStatus {
    return {
      schemaVersion: SCHEMA_VERSION,
      active: this.#active,
      directory: this.#directory,
      startedAt: this.#manifest.startedAt,
      bytesWritten: this.#bytesWritten,
      maxBytes: this.options.maxBytes,
      maxDurationMs: this.options.maxDurationMs,
      reason: this.#reason,
    };
  }

  public recordVideo(chunk: Buffer): void {
    if (!this.#active || chunk.length === 0) return;
    this.#enqueue(this.#video, chunk);
  }

  public recordEvent(type: string, details: Record<string, unknown> = {}): void {
    if (!this.#active) return;
    const line = Buffer.from(
      `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, timestamp: new Date().toISOString(), type, details })}\n`,
    );
    this.#enqueue(this.#events, line);
  }

  public async stop(): Promise<void> {
    if (this.#finalized) return;
    this.#finalized = true;
    if (this.#reason === "active") this.#reason = "completed";
    this.#active = false;
    clearTimeout(this.#timer);
    await this.#queue;
    await Promise.all([this.#video.close(), this.#events.close()]);
    const completed: RecordingManifest = {
      ...this.#manifest,
      endedAt: new Date().toISOString(),
      status: this.#reason,
      bytesWritten: this.#bytesWritten,
    };
    await writeFile(this.#partialManifestPath, `${JSON.stringify(completed, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(
      this.#partialManifestPath,
      join(dirname(this.#partialManifestPath), "manifest.json"),
    );
  }

  #enqueue(file: FileHandle, data: Buffer): void {
    if (this.#bytesWritten + data.length > this.options.maxBytes) {
      this.#reachLimit("size-limit");
      return;
    }
    this.#bytesWritten += data.length;
    this.#queue = this.#queue.then(async () => {
      await file.write(data);
    });
  }

  #reachLimit(reason: "size-limit" | "time-limit"): void {
    if (!this.#active) return;
    this.#active = false;
    this.#reason = reason;
    clearTimeout(this.#timer);
  }
}
