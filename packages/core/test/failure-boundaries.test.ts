import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  LogBuffer,
  parseUiHierarchy,
  type AdbRunner,
  type DisplayInfo,
  type RunResult,
} from "../src/index.js";

class FakeProcess extends EventEmitter {
  public stdin = new PassThrough();
  public stdout = new PassThrough();
  public stderr = new PassThrough();

  public kill(): boolean {
    this.emit("close", 0);
    return true;
  }
}

class StreamingAdb implements AdbRunner {
  public readonly processes: FakeProcess[] = [];

  public async run(): Promise<RunResult> {
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  public async capture(): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  public spawn(): never {
    const process = new FakeProcess();
    this.processes.push(process);
    return process as never;
  }
}

const display: DisplayInfo = {
  width: 1080,
  height: 1920,
  density: 420,
  orientation: "portrait",
};

function logLine(message: string): string {
  return `07-17 12:34:56.789  1234  1234 I Fixture: ${message}\n`;
}

async function flushStreams(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("UI hierarchy failure boundaries", () => {
  it("rejects structurally malformed XML instead of accepting a partial hierarchy", () => {
    expect(() =>
      parseUiHierarchy('<?xml version="1.0"?><hierarchy><node text="broken"></hierarchy>', display),
    ).toThrowError(expect.objectContaining({ code: "ADB_FAILED" }));
  });

  it("rejects well-formed XML that is not a UIAutomator hierarchy", () => {
    expect(() => parseUiHierarchy("<not-hierarchy />", display)).toThrowError(
      expect.objectContaining({
        code: "ADB_FAILED",
        message: "UIAutomator XML did not contain a hierarchy root.",
      }),
    );
  });
});

describe("Logcat failure boundaries", () => {
  it("keeps only the configured number of parsed entries across fragmented chunks", async () => {
    const adb = new StreamingAdb();
    const logs = new LogBuffer(3);
    logs.start(adb, "serial");
    const process = adb.processes[0]!;

    process.stdout.write(logLine("one").slice(0, 20));
    process.stdout.write(logLine("one").slice(20));
    process.stdout.write(logLine("two"));
    process.stdout.write(logLine("three"));
    process.stdout.write(logLine("four"));
    process.stdout.write(logLine("five"));
    await flushStreams();

    expect(logs.read("0")).toMatchObject({
      entries: [{ message: "three" }, { message: "four" }, { message: "five" }],
      nextCursor: "5",
    });
    logs.stop();
  });

  it("drops an oversized unterminated line and recovers at the next newline", async () => {
    const adb = new StreamingAdb();
    const logs = new LogBuffer();
    logs.start(adb, "serial");
    const process = adb.processes[0]!;

    for (let index = 0; index < 80; index += 1) process.stdout.write("x".repeat(1024));
    process.stdout.write(`\n${logLine("after oversized input")}`);
    await flushStreams();

    expect(logs.read("0")).toMatchObject({
      entries: [{ message: "after oversized input" }],
      nextCursor: "2",
    });
    logs.stop();
  });

  it("does not carry an unterminated fragment across Logcat restarts", async () => {
    const adb = new StreamingAdb();
    const logs = new LogBuffer();
    logs.start(adb, "serial");
    adb.processes[0]!.stdout.write("07-17 12:34:56.789  1234");
    await flushStreams();

    logs.stop();
    logs.start(adb, "serial");
    adb.processes[1]!.stdout.write(logLine("fresh process"));
    await flushStreams();

    expect(logs.read("0").entries).toEqual([
      expect.objectContaining({ message: "fresh process", pid: 1234 }),
    ]);
    logs.stop();
  });
});
