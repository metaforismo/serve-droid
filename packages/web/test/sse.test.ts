import { describe, expect, it } from "vitest";
import { createSseParser, type SseEvent } from "../src/sse.js";

describe("incremental SSE parser", () => {
  it("parses fragmented frames and multiple data lines", () => {
    const events: SseEvent[] = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push("event: progress\r\ndata: first");
    parser.push('\r\ndata: second\r\n\r\nevent: result\ndata: {"ok":true}\n\n');

    expect(events).toEqual([
      { event: "progress", data: "first\nsecond" },
      { event: "result", data: '{"ok":true}' },
    ]);
  });

  it("ignores comments and flushes a final frame", () => {
    const events: SseEvent[] = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push(": keepalive\nevent: error\ndata: failed");
    expect(events).toEqual([]);
    parser.finish();
    expect(events).toEqual([{ event: "error", data: "failed" }]);
  });
});
