import { createReadStream } from "node:fs";
import { lstat, open, readFile, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SCHEMA_VERSION, ServeDroidError } from "@serve-droid/core";

const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_EVENT_LINE_BYTES = 64 * 1024;
const TRACE_PID = 1;

type FinalRecordingStatus = "completed" | "size-limit" | "time-limit" | "crashed";

interface TraceRecordingManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  pid: number;
  serial: string;
  startedAt: string;
  endedAt: string;
  status: FinalRecordingStatus;
  bytesWritten: number;
  maxBytes: number;
  maxDurationMs: number;
  video: { path: "video.h264"; codec: "h264-annex-b" };
  events: { path: "events.jsonl"; format: "jsonl"; containsLogs: false };
}

interface RecordedEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  timestamp: string;
  monotonicUs?: number;
  sequence?: number;
  type: string;
  details: Record<string, unknown>;
}

interface TraceEvent {
  name: string;
  cat?: string;
  ph: "M" | "i";
  s?: "p" | "t";
  ts?: number;
  pid: number;
  tid: number;
  args: Record<string, unknown>;
}

export interface RecordingTraceExport {
  schemaVersion: typeof SCHEMA_VERSION;
  output: string;
  eventCount: number;
  droppedTrailingBytes: number;
  adjustedWallClockEvents: number;
  recordingStatus: FinalRecordingStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nodeCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function invalid(message: string): ServeDroidError {
  return new ServeDroidError("INVALID_ARGUMENT", message);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

async function readSmallJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) {
    throw invalid("Recording manifest is not a bounded regular file.");
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw invalid("Recording manifest is malformed JSON.");
    throw error;
  }
}

function validateManifest(value: unknown): TraceRecordingManifest {
  if (!isRecord(value)) throw invalid("Recording manifest is malformed.");
  const status = value.status;
  if (
    status !== "completed" &&
    status !== "size-limit" &&
    status !== "time-limit" &&
    status !== "crashed"
  ) {
    throw invalid("Recording must be finalized or recovered before trace export.");
  }
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    typeof value.serial !== "string" ||
    value.serial.length === 0 ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    typeof value.endedAt !== "string" ||
    !Number.isFinite(Date.parse(value.endedAt)) ||
    !isNonNegativeSafeInteger(value.bytesWritten) ||
    !Number.isSafeInteger(value.maxBytes) ||
    Number(value.maxBytes) < 1024 * 1024 ||
    Number(value.bytesWritten) > Number(value.maxBytes) ||
    !Number.isSafeInteger(value.maxDurationMs) ||
    Number(value.maxDurationMs) < 1_000 ||
    !isRecord(value.video) ||
    value.video.path !== "video.h264" ||
    value.video.codec !== "h264-annex-b" ||
    !isRecord(value.events) ||
    value.events.path !== "events.jsonl" ||
    value.events.format !== "jsonl" ||
    value.events.containsLogs !== false
  ) {
    throw invalid("Recording manifest does not match the serve-droid recording contract.");
  }
  return value as unknown as TraceRecordingManifest;
}

async function loadFinalManifest(directory: string): Promise<TraceRecordingManifest> {
  for (const name of ["manifest.json", "manifest.crashed.json"] as const) {
    const path = join(directory, name);
    try {
      return validateManifest(await readSmallJson(path));
    } catch (error) {
      if (nodeCode(error) === "ENOENT") continue;
      throw error;
    }
  }
  try {
    const partial = await lstat(join(directory, "manifest.partial.json"));
    if (partial.isFile()) {
      throw invalid("Recording is still active or unrecovered; stop or recover it first.");
    }
  } catch (error) {
    if (error instanceof ServeDroidError) throw error;
    if (nodeCode(error) !== "ENOENT") throw error;
  }
  throw invalid("Directory is not a finalized serve-droid recording.");
}

function parseRecordedEvent(line: Buffer): RecordedEvent {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8")) as unknown;
  } catch {
    throw invalid("Recording event stream contains malformed JSON.");
  }
  const hasMonotonic = isRecord(value) && value.monotonicUs !== undefined;
  const hasSequence = isRecord(value) && value.sequence !== undefined;
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    typeof value.type !== "string" ||
    value.type.length === 0 ||
    value.type.length > 128 ||
    !isRecord(value.details) ||
    hasMonotonic !== hasSequence ||
    (hasMonotonic && !isNonNegativeSafeInteger(value.monotonicUs)) ||
    (hasSequence && !isNonNegativeSafeInteger(value.sequence))
  ) {
    throw invalid("Recording event stream contains an invalid event envelope.");
  }
  return value as unknown as RecordedEvent;
}

function track(type: string): { category: string; tid: number } {
  if (type === "session-start" || type === "session-stop" || type.startsWith("recording-"))
    return { category: "serve-droid.lifecycle", tid: 1 };
  if (type === "action") return { category: "serve-droid.input", tid: 2 };
  if (type === "app" || type === "permission" || type === "file")
    return { category: "serve-droid.device", tid: 3 };
  if (type === "screenshot") return { category: "serve-droid.capture", tid: 4 };
  if (type.startsWith("video-") || type === "display-size")
    return { category: "serve-droid.transport", tid: 5 };
  return { category: "serve-droid.event", tid: 6 };
}

function eventName(event: RecordedEvent): string {
  const qualifier =
    event.type === "action"
      ? event.details.action
      : event.type === "app" || event.type === "permission" || event.type === "file"
        ? event.details.operation
        : undefined;
  return typeof qualifier === "string" && qualifier.length > 0
    ? `${event.type}:${qualifier}`
    : event.type;
}

function sourceTimestampUs(
  event: RecordedEvent,
  startedAtMs: number,
): {
  timestampUs: number;
  timingSource: "monotonic" | "wall-clock";
} {
  if (isNonNegativeSafeInteger(event.monotonicUs)) {
    return { timestampUs: event.monotonicUs, timingSource: "monotonic" };
  }
  return {
    timestampUs: Math.max(0, Math.round((Date.parse(event.timestamp) - startedAtMs) * 1000)),
    timingSource: "wall-clock",
  };
}

function metadataEvents(): TraceEvent[] {
  const names = ["Lifecycle", "Input", "Device", "Capture", "Transport", "Events"];
  return [
    {
      name: "process_name",
      ph: "M",
      pid: TRACE_PID,
      tid: 0,
      args: { name: "serve-droid recording" },
    },
    ...names.map((name, index) => ({
      name: "thread_name" as const,
      ph: "M" as const,
      pid: TRACE_PID,
      tid: index + 1,
      args: { name },
    })),
  ];
}

async function writeTraceEvent(
  file: FileHandle,
  event: TraceEvent,
  state: { first: boolean },
): Promise<void> {
  if (!state.first) await file.write(",\n");
  state.first = false;
  await file.write(JSON.stringify(event));
}

export async function exportRecordingTrace(
  recordingDirectory: string,
  outputPath: string,
): Promise<RecordingTraceExport> {
  const directory = resolve(recordingDirectory);
  const manifest = await loadFinalManifest(directory);
  const eventsPath = join(directory, manifest.events.path);
  const videoPath = join(directory, manifest.video.path);
  let eventInfo;
  let videoInfo;
  try {
    [eventInfo, videoInfo] = await Promise.all([lstat(eventsPath), lstat(videoPath)]);
  } catch (error) {
    if (nodeCode(error) === "ENOENT") throw invalid("Recording stream file is missing.");
    throw error;
  }
  if (!eventInfo.isFile() || !videoInfo.isFile()) {
    throw invalid("Recording stream files must be regular files.");
  }
  const observedBytesWritten = eventInfo.size + videoInfo.size;
  if (
    !Number.isSafeInteger(observedBytesWritten) ||
    observedBytesWritten < 0 ||
    observedBytesWritten > manifest.maxBytes
  ) {
    throw invalid("Recording stream files exceed the declared byte limit.");
  }

  const target = resolve(outputPath);
  try {
    const parent = await stat(dirname(target));
    if (!parent.isDirectory()) throw invalid("Trace output parent is not a directory.");
  } catch (error) {
    if (error instanceof ServeDroidError) throw error;
    if (nodeCode(error) === "ENOENT")
      throw invalid("Trace output parent directory does not exist.");
    throw error;
  }

  let output: FileHandle | undefined;
  let created = false;
  try {
    try {
      output = await open(target, "wx", 0o600);
      created = true;
    } catch (error) {
      if (nodeCode(error) === "EEXIST") {
        throw invalid("Trace output already exists; choose a new output path.");
      }
      throw error;
    }

    await output.write("[\n");
    const writeState = { first: true };
    for (const event of metadataEvents()) await writeTraceEvent(output, event, writeState);
    await writeTraceEvent(
      output,
      {
        name: "recording-manifest",
        cat: "serve-droid.lifecycle",
        ph: "i",
        s: "p",
        ts: 0,
        pid: TRACE_PID,
        tid: 1,
        args: {
          serial: manifest.serial,
          status: manifest.status,
          startedAt: manifest.startedAt,
          endedAt: manifest.endedAt,
          bytesWritten: observedBytesWritten,
          manifestBytesWritten: manifest.bytesWritten,
          maxBytes: manifest.maxBytes,
          maxDurationMs: manifest.maxDurationMs,
          videoCodec: manifest.video.codec,
          sourceEventFormat: manifest.events.format,
          containsLogs: false,
        },
      },
      writeState,
    );

    const startedAtMs = Date.parse(manifest.startedAt);
    const stream = createReadStream(eventsPath, { highWaterMark: 16 * 1024 });
    let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let eventCount = 0;
    let lastTimestampUs = 0;
    let lastMonotonicSequence: number | undefined;
    let adjustedWallClockEvents = 0;
    let droppedTrailingBytes = 0;

    const consume = async (line: Buffer): Promise<void> => {
      if (line.length === 0) return;
      if (line.length > MAX_EVENT_LINE_BYTES) {
        throw invalid("Recording event line exceeds the 64 KiB trace-export limit.");
      }
      const normalized = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
      const event = parseRecordedEvent(normalized);
      const timing = sourceTimestampUs(event, startedAtMs);
      let timestampUs = timing.timestampUs;
      let timingAdjusted = false;

      if (timing.timingSource === "monotonic") {
        if (eventCount > 0 && timestampUs < lastTimestampUs) {
          throw invalid("Recording monotonic timestamps are not ordered.");
        }
        if (
          lastMonotonicSequence !== undefined &&
          Number(event.sequence) <= lastMonotonicSequence
        ) {
          throw invalid("Recording event sequence is not strictly increasing.");
        }
        lastMonotonicSequence = Number(event.sequence);
      } else if (timestampUs < lastTimestampUs) {
        timingAdjusted = true;
        adjustedWallClockEvents += 1;
        timestampUs = lastTimestampUs;
      }

      const placement = track(event.type);
      await writeTraceEvent(
        output!,
        {
          name: eventName(event),
          cat: placement.category,
          ph: "i",
          s: "t",
          ts: timestampUs,
          pid: TRACE_PID,
          tid: placement.tid,
          args: {
            ...event.details,
            eventTimestamp: event.timestamp,
            eventSequence: event.sequence ?? eventCount,
            timingSource: timing.timingSource,
            ...(timingAdjusted
              ? { timingAdjusted: true, sourceTimestampUs: timing.timestampUs }
              : {}),
          },
        },
        writeState,
      );
      lastTimestampUs = timestampUs;
      eventCount += 1;
    };

    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      buffered = buffered.length === 0 ? bytes : Buffer.concat([buffered, bytes]);
      let newline = buffered.indexOf(0x0a);
      while (newline >= 0) {
        await consume(buffered.subarray(0, newline));
        buffered = buffered.subarray(newline + 1);
        newline = buffered.indexOf(0x0a);
      }
      if (buffered.length > MAX_EVENT_LINE_BYTES) {
        throw invalid("Recording event line exceeds the 64 KiB trace-export limit.");
      }
    }
    if (buffered.length > 0) {
      if (manifest.status === "crashed") droppedTrailingBytes = buffered.length;
      else throw invalid("Finalized recording ends with an incomplete event line.");
    }

    await writeTraceEvent(
      output,
      {
        name: "trace-export",
        cat: "serve-droid.lifecycle",
        ph: "i",
        s: "p",
        ts: lastTimestampUs,
        pid: TRACE_PID,
        tid: 1,
        args: { sourceEventCount: eventCount, droppedTrailingBytes, adjustedWallClockEvents },
      },
      writeState,
    );
    await output.write("\n]\n");
    await output.sync();
    await output.close();
    output = undefined;
    return {
      schemaVersion: SCHEMA_VERSION,
      output: target,
      eventCount,
      droppedTrailingBytes,
      adjustedWallClockEvents,
      recordingStatus: manifest.status,
    };
  } catch (error) {
    await output?.close().catch(() => undefined);
    if (created) await rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}
