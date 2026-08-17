import { describe, expect, it } from "vitest";
import { PointerStreamClient } from "../src/pointer-stream.js";
import type { PointerStreamError } from "../src/pointer-stream.js";

class FakeSocket {
  public readyState = 0;
  public readonly sent: Array<Record<string, unknown>> = [];
  public onopen: ((event: Event) => unknown) | null = null;
  public onmessage: ((event: MessageEvent) => unknown) | null = null;
  public onerror: ((event: Event) => unknown) | null = null;
  public onclose: ((event: CloseEvent) => unknown) | null = null;

  public open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  public send(value: string): void {
    this.sent.push(JSON.parse(value) as Record<string, unknown>);
  }

  public respond(value: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }

  public close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

function phase(message: Record<string, unknown>): string | undefined {
  const gesture = message.gesture as
    { stream?: { phase?: string }; points?: Array<{ x: number; y: number }> } | undefined;
  return gesture?.stream?.phase;
}

function point(message: Record<string, unknown>): { x: number; y: number } | undefined {
  const gesture = message.gesture as { points?: Array<{ x: number; y: number }> } | undefined;
  return gesture?.points?.[0];
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("PointerStreamClient", () => {
  it("streams begin and move before release while coalescing pending move updates", async () => {
    const socket = new FakeSocket();
    const client = new PointerStreamClient({
      createSocket: () => socket as unknown as WebSocket,
    });
    client.start();
    socket.open();

    const began = client.begin({ x: 0.1, y: 0.2 });
    await settle();
    expect(phase(socket.sent[0]!)).toBe("begin");
    socket.respond({ schemaVersion: 1, ok: true });
    await expect(began).resolves.toBe(true);

    client.move({ x: 0.2, y: 0.3 });
    await settle();
    expect(phase(socket.sent[1]!)).toBe("move");
    client.move({ x: 0.4, y: 0.5 });
    client.move({ x: 0.7, y: 0.8 });
    socket.respond({ schemaVersion: 1, ok: true });
    await settle();
    expect(phase(socket.sent[2]!)).toBe("move");
    expect(point(socket.sent[2]!)).toEqual({ x: 0.7, y: 0.8 });
    socket.respond({ schemaVersion: 1, ok: true });

    const ended = client.end({ x: 0.9, y: 1 });
    await settle();
    expect(phase(socket.sent[3]!)).toBe("end");
    socket.respond({ schemaVersion: 1, ok: true });
    await ended;
    client.close();
  });

  it("returns the bounded action fallback only for an explicit pre-injection rejection", async () => {
    const socket = new FakeSocket();
    const client = new PointerStreamClient({
      createSocket: () => socket as unknown as WebSocket,
    });
    client.start();
    socket.open();

    const began = client.begin({ x: 0.5, y: 0.5 });
    await settle();
    socket.respond({
      schemaVersion: 1,
      error: {
        code: "TRANSPORT_FAILED",
        message: "Live pointer streaming requires an active scrcpy control channel.",
        details: { safeToFallback: true },
      },
    });

    await expect(began).resolves.toBe(false);
    client.close();
  });

  it("fails closed when the socket disappears after a live begin", async () => {
    const socket = new FakeSocket();
    const errors: PointerStreamError[] = [];
    const client = new PointerStreamClient({
      createSocket: () => socket as unknown as WebSocket,
      onError: (error) => errors.push(error),
    });
    client.start();
    socket.open();

    const began = client.begin({ x: 0.2, y: 0.2 });
    await settle();
    socket.respond({ schemaVersion: 1, ok: true });
    await began;
    socket.close(1011, "transport lost");

    await expect(client.end({ x: 0.8, y: 0.8 })).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
    });
    expect(errors).toHaveLength(1);
    client.close();
  });
});
