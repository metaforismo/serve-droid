import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recoverPartialRecordings, removeRecording, SessionRecorder } from "../src/recording.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "serve-droid-recording-test-"));
  roots.push(path);
  return path;
}

describe("session recording", () => {
  it("writes raw H.264 and redacted JSONL events with a final manifest", async () => {
    const recorder = await SessionRecorder.create({
      directory: await root(),
      serial: "emulator-5554",
      maxBytes: 1024 * 1024,
      maxDurationMs: 60_000,
    });
    recorder.recordVideo(Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]));
    recorder.recordEvent("action", { action: "type", textLength: 18 });
    await recorder.stop();

    const video = await readFile(join(recorder.status.directory, "video.h264"));
    const events = await readFile(join(recorder.status.directory, "events.jsonl"), "utf8");
    const manifest = JSON.parse(
      await readFile(join(recorder.status.directory, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(video).toEqual(Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]));
    expect(events).toContain('"textLength":18');
    expect(events).not.toContain("user-secret-text");
    expect(manifest).toMatchObject({ status: "completed", bytesWritten: expect.any(Number) });
  });

  it("stops accepting complete chunks at the byte limit", async () => {
    const recorder = await SessionRecorder.create({
      directory: await root(),
      serial: "serial",
      maxBytes: 1024 * 1024,
      maxDurationMs: 60_000,
    });
    recorder.recordVideo(Buffer.alloc(1024 * 1024 + 1));
    expect(recorder.status).toMatchObject({ active: false, reason: "size-limit", bytesWritten: 0 });
    await recorder.stop();
  });

  it("recovers dead-process partial manifests and removes only recognized recordings", async () => {
    const parent = await root();
    const directory = join(parent, "session-crashed");
    await mkdir(directory);
    await writeFile(join(directory, "video.h264"), "");
    await writeFile(join(directory, "events.jsonl"), "");
    await writeFile(
      join(directory, "manifest.partial.json"),
      JSON.stringify({
        schemaVersion: 1,
        pid: 999_999_999,
        serial: "serial",
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active",
        bytesWritten: 0,
        maxBytes: 1024 * 1024,
        maxDurationMs: 60_000,
        video: { path: "video.h264", codec: "h264-annex-b" },
        events: { path: "events.jsonl", format: "jsonl", containsLogs: false },
      }),
    );
    await expect(recoverPartialRecordings(parent)).resolves.toEqual([
      join(directory, "manifest.crashed.json"),
    ]);
    await removeRecording(directory);
    await expect(stat(directory)).rejects.toThrow();
    await expect(removeRecording(parent)).rejects.toThrow(/not a serve-droid recording/u);
  });
});
