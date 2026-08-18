import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export const MCP_STDIO_MAX_MESSAGE_BYTES = 1024 * 1024;

function transportError(message: string): Error {
  return new Error(`serve-droid MCP stdio: ${message}`);
}

export class BoundedStdioServerTransport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  readonly #line = Buffer.allocUnsafe(MCP_STDIO_MAX_MESSAGE_BYTES);
  #length = 0;
  #discardingOversizedLine = false;
  #started = false;

  public constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
  ) {}

  readonly #onData = (chunk: Buffer | string): void => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;

    while (offset < data.length) {
      const newline = data.indexOf(0x0a, offset);
      const end = newline >= 0 ? newline : data.length;
      const segment = data.subarray(offset, end);

      if (!this.#discardingOversizedLine) {
        const remaining = MCP_STDIO_MAX_MESSAGE_BYTES - this.#length;
        if (segment.length > remaining) {
          this.#length = 0;
          this.#discardingOversizedLine = true;
          this.onerror?.(
            transportError(`message exceeds ${MCP_STDIO_MAX_MESSAGE_BYTES} bytes and was discarded.`),
          );
        } else {
          segment.copy(this.#line, this.#length);
          this.#length += segment.length;
        }
      }

      if (newline < 0) return;
      if (this.#discardingOversizedLine) {
        this.#discardingOversizedLine = false;
        this.#length = 0;
      } else {
        this.#emitLine();
      }
      offset = newline + 1;
    }
  };

  readonly #onError = (error: Error): void => this.onerror?.(error);

  public async start(): Promise<void> {
    if (this.#started) throw transportError("transport was already started.");
    this.#started = true;
    this.input.on("data", this.#onData);
    this.input.on("error", this.#onError);
  }

  public async close(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    this.input.off("data", this.#onData);
    this.input.off("error", this.#onError);
    this.#length = 0;
    this.#discardingOversizedLine = false;
    if (this.input.listenerCount("data") === 0) this.input.pause();
    this.onclose?.();
  }

  public async send(message: JSONRPCMessage): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    if (this.output.write(line)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.output.off("drain", onDrain);
        this.output.off("error", onError);
        this.output.off("close", onClose);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(transportError("output closed before buffered data drained."));
      };
      this.output.once("drain", onDrain);
      this.output.once("error", onError);
      this.output.once("close", onClose);
    });
  }

  #emitLine(): void {
    let length = this.#length;
    if (length > 0 && this.#line[length - 1] === 0x0d) length -= 1;
    const raw = this.#line.toString("utf8", 0, length);
    this.#length = 0;
    if (!raw) {
      this.onerror?.(transportError("empty message was discarded."));
      return;
    }
    try {
      this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(raw)));
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : transportError(String(error)));
    }
  }
}
