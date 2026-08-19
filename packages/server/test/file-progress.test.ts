import { describe, expect, it } from "vitest";
import {
  acceptsFileProgressStream,
  fileProgressEvent,
  writeFileProgressFrame,
} from "../src/file-progress.js";

describe("file progress SSE helpers", () => {
  it("negotiates only an explicit event-stream accept value", () => {
    expect(acceptsFileProgressStream(undefined)).toBe(false);
    expect(acceptsFileProgressStream("application/json")).toBe(false);
    expect(acceptsFileProgressStream("application/json, text/event-stream; q=0.9")).toBe(true);
    expect(acceptsFileProgressStream(["TEXT/EVENT-STREAM"])).toBe(true);
  });

  it("emits a stable progress envelope", () => {
    expect(fileProgressEvent("install", "installing", "Installing APK on Android.")).toEqual({
      schemaVersion: 1,
      type: "file-progress",
      operation: "install",
      phase: "installing",
      message: "Installing APK on Android.",
    });
  });

  it("writes one complete SSE frame without buffering extra state", () => {
    let output = "";
    const response = {
      write(value: string) {
        output += value;
        return true;
      },
    };
    expect(
      writeFileProgressFrame(
        response,
        "progress",
        fileProgressEvent("push", "pushing", "Pushing file to Android."),
      ),
    ).toBe(true);
    expect(output).toBe(
      'event: progress\ndata: {"schemaVersion":1,"type":"file-progress","operation":"push","phase":"pushing","message":"Pushing file to Android."}\n\n',
    );
  });
});
