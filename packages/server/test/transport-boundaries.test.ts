import { describe, expect, it, vi } from "vitest";
import type { LogEntry } from "@serve-droid/core";
import {
  decodeUploadName,
  parseJsonObject,
  sseResumeCursor,
  writeSseLogFrame,
} from "../src/transport-boundaries.js";

const logEntry: LogEntry = {
  cursor: "42",
  timestamp: "2026-08-18T12:00:00.000Z",
  pid: 1234,
  tid: 1234,
  priority: "I",
  tag: "Fixture",
  message: "ready",
};

describe("JSON transport envelopes", () => {
  it("accepts JSON objects and rejects malformed or non-object envelopes", () => {
    expect(parseJsonObject('{"type":"tap"}')).toEqual({ type: "tap" });
    for (const raw of ["{", "null", "[]", "42", '"text"']) {
      expect(() => parseJsonObject(raw)).toThrowError(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
    }
  });
});

describe("upload names", () => {
  it("decodes safe names, strips client paths, and rejects malformed encoding", () => {
    expect(decodeUploadName("fixture%20app.apk")).toBe("fixture app.apk");
    expect(decodeUploadName("..%2Ffolder%2Ffixture.apk")).toBe("fixture.apk");
    expect(() => decodeUploadName("%E0%A4%A")).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(() => decodeUploadName("%00.apk")).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });
});

describe("Logcat SSE boundaries", () => {
  it("resumes from the newest valid query or Last-Event-ID cursor", () => {
    expect(sseResumeCursor("10", "12")).toBe("12");
    expect(sseResumeCursor("15", "12")).toBe("15");
    expect(sseResumeCursor("invalid", "7")).toBe("7");
    expect(sseResumeCursor("3", "999999999999999999999")).toBe("3");
  });

  it("emits resumable ids and closes a slow SSE response at backpressure", () => {
    const fast = { write: vi.fn(() => true), end: vi.fn() };
    expect(writeSseLogFrame(fast as never, logEntry)).toBe(true);
    expect(fast.write).toHaveBeenCalledWith(
      expect.stringContaining('id: 42\ndata: {"cursor":"42"'),
    );
    expect(fast.end).not.toHaveBeenCalled();

    const slow = { write: vi.fn(() => false), end: vi.fn() };
    expect(writeSseLogFrame(slow as never, logEntry)).toBe(false);
    expect(slow.end).toHaveBeenCalledTimes(1);
  });
});
