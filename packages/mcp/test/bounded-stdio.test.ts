import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  BoundedStdioServerTransport,
  MCP_STDIO_MAX_MESSAGE_BYTES,
} from "../src/bounded-stdio.js";

const notification = '{"jsonrpc":"2.0","method":"notifications/initialized"}\n';

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("bounded MCP stdio input", () => {
  it("parses fragmented valid messages", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new BoundedStdioServerTransport(input, output);
    const messages: unknown[] = [];
    transport.onmessage = (message) => messages.push(message);
    await transport.start();

    input.write(notification.slice(0, 12));
    input.write(notification.slice(12));
    await flush();

    expect(messages).toEqual([
      expect.objectContaining({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ]);
    await transport.close();
  });

  it("discards malformed input and continues with the next message", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new BoundedStdioServerTransport(input, output);
    const errors: Error[] = [];
    const messages: unknown[] = [];
    transport.onerror = (error) => errors.push(error);
    transport.onmessage = (message) => messages.push(message);
    await transport.start();

    input.write("{not-json}\n");
    input.write(notification);
    await flush();

    expect(errors).toHaveLength(1);
    expect(messages).toHaveLength(1);
    await transport.close();
  });

  it("bounds an unterminated oversized line and recovers after its newline", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new BoundedStdioServerTransport(input, output);
    const errors: Error[] = [];
    const messages: unknown[] = [];
    transport.onerror = (error) => errors.push(error);
    transport.onmessage = (message) => messages.push(message);
    await transport.start();

    for (let offset = 0; offset < MCP_STDIO_MAX_MESSAGE_BYTES + 4096; offset += 4096) {
      input.write(Buffer.alloc(4096, 0x78));
    }
    input.write(`\n${notification}`);
    await flush();

    expect(errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(`${MCP_STDIO_MAX_MESSAGE_BYTES} bytes`),
      }),
    ]);
    expect(messages).toHaveLength(1);
    await transport.close();
  });
});

describe("bounded MCP stdio output", () => {
  it("waits for drain after Writable backpressure", async () => {
    let release: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        release = callback;
      },
    });
    const input = new PassThrough();
    const transport = new BoundedStdioServerTransport(input, output);
    let settled = false;

    const pending = transport
      .send({ jsonrpc: "2.0", method: "notifications/initialized" })
      .then(() => {
        settled = true;
      });
    await flush();
    expect(settled).toBe(false);

    release?.();
    await pending;
    expect(settled).toBe(true);
  });

  it("rejects if a backpressured output closes before drain", async () => {
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {},
    });
    const transport = new BoundedStdioServerTransport(new PassThrough(), output);
    const pending = transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    output.emit("close");

    await expect(pending).rejects.toThrow(/closed before buffered data drained/u);
  });
});
