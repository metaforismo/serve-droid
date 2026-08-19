import { describe, expect, it } from "vitest";
import { cliProgressEvent, writeCliProgress } from "../src/progress.js";

describe("CLI progress events", () => {
  it("keeps machine progress on stderr-compatible NDJSON without changing the final stdout contract", () => {
    const output: string[] = [];
    writeCliProgress(
      { json: true },
      cliProgressEvent("install", "installing", 1, "Installing APK on Android."),
      (value) => output.push(value),
    );
    expect(output).toEqual([
      '{"schemaVersion":1,"type":"progress","operation":"install","phase":"installing","step":1,"total":2,"message":"Installing APK on Android."}\n',
    ]);
  });

  it("writes concise human progress and honors quiet mode", () => {
    const output: string[] = [];
    writeCliProgress(
      {},
      cliProgressEvent("push", "pushing", 1, "Pushing file to Android."),
      (value) => output.push(value),
    );
    writeCliProgress(
      { quiet: true },
      cliProgressEvent("push", "completed", 2, "Push complete."),
      (value) => output.push(value),
    );
    expect(output).toEqual(["Pushing file to Android.\n"]);
  });
});
