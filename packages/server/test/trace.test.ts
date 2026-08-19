import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRecorder } from "../src/recording.js";
import { exportRecordingTrace } from "../src/trace.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "serve-droid-trace-test-"));
  roots.push(path);
  return path;
}

describe("recording trace export", () => {
  it("streams finalized privacy-filtered events into Chrome Trace Event JSON", async () => {
    const parent = await root();
    const recorder = await SessionRecorder.create({
      directory: parent,
      serial: "emulator-5554",
      maxBytes: 1024 * 1024,
      maxDurationMs: 60_000,
    });
    recorder.recordEvent("session-start", { serial: "emulator-5554", width: 1080, height: 1920 });
    recorder.recordEvent("action", { action: "type", textLength: 18 });
    recorder.recordEvent("file", { operation: "push" });
    await recorder.stop();

    const eventLines = (await readFile(join(recorder.status.directory, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(eventLines.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(eventLines.every((event) => Number.isSafeInteger(event.monotonicUs))).toBe(true);

    const output = join(parent, "recording.trace.json");
    const result = await exportRecordingTrace(recorder.status.directory, output);
    expect(result).toMatchObject({
      eventCount: 3,
      droppedTrailingBytes: 0,
      recordingStatus: "completed",
    });

    const trace = JSON.parse(await readFile(output, "utf8")) as Array<Record<string, unknown>>;
    expect(trace.some((event) => event.name === "process_name" && event.ph === "M")).toBe(true);
    expect(trace).toContainEqual(
      expect.objectContaining({
        name: "action:type",
        cat: "serve-droid.input",
        ph: "i",
        tid: 2,
        args: expect.objectContaining({ textLength: 18, timingSource: "monotonic" }),
      }),
    );
    expect(JSON.stringify(trace)).not.toContain("user-secret-text");
    expect(trace.at(-1)).toMatchObject({
      name: "trace-export",
      args: { sourceEventCount: 3, droppedTrailingBytes: 0 },
    });
  });

  it("exports recovered crash data while dropping only a final incomplete event", async () => {
    const parent = await root();
    const directory = join(parent, "session-crashed");
    await mkdir(directory);
    await writeFile(join(directory, "video.h264"), "");
    await writeFile(
      join(directory, "events.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        timestamp: "2026-08-19T12:00:00.010Z",
        type: "video-restart",
        details: { attempt: 1, maxAttempts: 1 },
      })}\n{"partial":`,
    );
    await writeFile(
      join(directory, "manifest.crashed.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 999999999,
        serial: "crashed-serial",
        startedAt: "2026-08-19T12:00:00.000Z",
        endedAt: "2026-08-19T12:01:00.000Z",
        status: "crashed",
        bytesWritten: 128,
        maxBytes: 1024 * 1024,
        maxDurationMs: 60_000,
        video: { path: "video.h264", codec: "h264-annex-b" },
        events: { path: "events.jsonl", format: "jsonl", containsLogs: false },
      })}\n`,
    );

    const output = join(parent, "crashed.trace.json");
    const result = await exportRecordingTrace(directory, output);
    expect(result.eventCount).toBe(1);
    expect(result.droppedTrailingBytes).toBeGreaterThan(0);
    expect(result.recordingStatus).toBe("crashed");
    const trace = JSON.parse(await readFile(output, "utf8")) as Array<Record<string, unknown>>;
    expect(trace).toContainEqual(
      expect.objectContaining({
        name: "video-restart",
        ts: 10_000,
        args: expect.objectContaining({ timingSource: "wall-clock" }),
      }),
    );
  });

  it("rejects active recordings without leaving a partial trace", async () => {
    const parent = await root();
    const recorder = await SessionRecorder.create({
      directory: parent,
      serial: "active",
      maxBytes: 1024 * 1024,
      maxDurationMs: 60_000,
    });
    const output = join(parent, "active.trace.json");
    await expect(exportRecordingTrace(recorder.status.directory, output)).rejects.toThrow(
      /active|unrecovered|finalized/u,
    );
    await expect(stat(output)).rejects.toThrow();
    await recorder.stop();
  });

  it("fails closed on oversized event lines and removes the output file", async () => {
    const parent = await root();
    const directory = join(parent, "session-oversized");
    await mkdir(directory);
    await writeFile(join(directory, "video.h264"), "");
    await writeFile(join(directory, "events.jsonl"), `${"x".repeat(64 * 1024 + 1)}\n`);
    await writeFile(
      join(directory, "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 1,
        serial: "oversized",
        startedAt: "2026-08-19T12:00:00.000Z",
        endedAt: "2026-08-19T12:00:01.000Z",
        status: "completed",
        bytesWritten: 64 * 1024 + 1,
        maxBytes: 1024 * 1024,
        maxDurationMs: 60_000,
        video: { path: "video.h264", codec: "h264-annex-b" },
        events: { path: "events.jsonl", format: "jsonl", containsLogs: false },
      })}\n`,
    );
    const output = join(parent, "oversized.trace.json");
    await expect(exportRecordingTrace(directory, output)).rejects.toThrow(/64 KiB/u);
    await expect(stat(output)).rejects.toThrow();
  });
});
