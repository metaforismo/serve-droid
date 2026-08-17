import { describe, expect, it } from "vitest";
import {
  DecodedFrameBroker,
  jpegDimensions,
  type DecodedFrameProvider,
} from "../src/decoded-frame.js";

class FakeProvider implements DecodedFrameProvider {
  public readyState = 1;
  public bufferedAmount = 0;
  public readonly sent: string[] = [];
  public failSend = false;

  public send(data: string): void {
    if (this.failSend) throw new Error("socket closed");
    this.sent.push(data);
  }
}

function jpeg(width = 3, height = 2): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

function request(provider: FakeProvider): {
  id: string;
  maxWidth: number;
  quality: number;
  maxBytes: number;
} {
  return JSON.parse(provider.sent.at(-1)!) as {
    id: string;
    maxWidth: number;
    quality: number;
    maxBytes: number;
  };
}

function frameResponse(id: string, data = jpeg(), width = 3, height = 2): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: "decoded-frame",
    id,
    mimeType: "image/jpeg",
    width,
    height,
    data: data.toString("base64"),
  });
}

describe("JPEG dimension parsing", () => {
  it("reads dimensions from a bounded SOF segment", () => {
    expect(jpegDimensions(jpeg(1_080, 1_920))).toEqual({ width: 1_080, height: 1_920 });
  });

  it("rejects truncated and non-JPEG payloads", () => {
    expect(jpegDimensions(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(jpegDimensions(Buffer.from("not-a-jpeg"))).toBeNull();
  });
});

describe("DecodedFrameBroker", () => {
  it("returns immediately when no decoded-frame provider is connected", async () => {
    const broker = new DecodedFrameBroker();
    await expect(broker.capture()).resolves.toBeNull();
  });

  it("accepts the first canonical JPEG whose declared and real dimensions agree", async () => {
    const broker = new DecodedFrameBroker();
    const provider = new FakeProvider();
    broker.register(provider);

    const pending = broker.capture({ maxWidth: 1_080, quality: 75, timeoutMs: 250 });
    const captureRequest = request(provider);
    expect(captureRequest.id).toMatch(/^[a-f0-9]{32}$/u);
    expect(captureRequest).toMatchObject({ maxWidth: 1_080, quality: 75 });
    expect(broker.receive(provider, frameResponse(captureRequest.id))).toBe(true);

    await expect(pending).resolves.toMatchObject({
      data: jpeg(),
      mimeType: "image/jpeg",
      width: 3,
      height: 2,
    });
  });

  it("deduplicates concurrent callers into one bounded request", async () => {
    const broker = new DecodedFrameBroker();
    const provider = new FakeProvider();
    broker.register(provider);

    const first = broker.capture({ timeoutMs: 250 });
    const second = broker.capture({ timeoutMs: 250 });
    expect(second).toBe(first);
    expect(provider.sent).toHaveLength(1);
    broker.receive(provider, frameResponse(request(provider).id));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("serializes concurrent callers when their capture bounds differ", async () => {
    const broker = new DecodedFrameBroker();
    const provider = new FakeProvider();
    broker.register(provider);

    const first = broker.capture({ maxWidth: 1_080, quality: 75, timeoutMs: 250 });
    const firstRequest = request(provider);
    const second = broker.capture({ maxWidth: 320, quality: 60, timeoutMs: 250 });
    expect(second).not.toBe(first);
    expect(provider.sent).toHaveLength(1);

    broker.receive(provider, frameResponse(firstRequest.id));
    await expect(first).resolves.toMatchObject({ width: 3, height: 2 });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    expect(provider.sent).toHaveLength(2);
    const secondRequest = request(provider);
    expect(secondRequest).toMatchObject({ maxWidth: 320, quality: 60 });
    broker.receive(provider, frameResponse(secondRequest.id));
    await expect(second).resolves.toMatchObject({ width: 3, height: 2 });
  });

  it("allows another provider to win after one returns malformed data", async () => {
    const broker = new DecodedFrameBroker();
    const first = new FakeProvider();
    const second = new FakeProvider();
    broker.register(first);
    broker.register(second);

    const pending = broker.capture({ timeoutMs: 250 });
    const id = request(first).id;
    expect(request(second).id).toBe(id);
    expect(broker.receive(first, frameResponse(id, jpeg(), 4, 2))).toBe(true);
    expect(broker.receive(second, frameResponse(id))).toBe(true);
    await expect(pending).resolves.toMatchObject({ width: 3, height: 2 });
  });

  it("falls back after every provider reports an unavailable frame", async () => {
    const broker = new DecodedFrameBroker();
    const provider = new FakeProvider();
    broker.register(provider);
    const pending = broker.capture({ timeoutMs: 250 });
    const { id } = request(provider);

    broker.receive(
      provider,
      JSON.stringify({
        schemaVersion: 1,
        type: "decoded-frame-error",
        id,
        code: "FRAME_NOT_READY",
      }),
    );
    await expect(pending).resolves.toBeNull();
  });

  it("times out without retaining the in-flight request", async () => {
    const broker = new DecodedFrameBroker();
    const provider = new FakeProvider();
    broker.register(provider);

    await expect(broker.capture({ timeoutMs: 25 })).resolves.toBeNull();
    const next = broker.capture({ timeoutMs: 250 });
    expect(provider.sent).toHaveLength(2);
    broker.receive(provider, frameResponse(request(provider).id));
    await expect(next).resolves.not.toBeNull();
  });

  it("falls back when every eligible send fails or disconnects", async () => {
    const broker = new DecodedFrameBroker();
    const failed = new FakeProvider();
    failed.failSend = true;
    broker.register(failed);
    await expect(broker.capture({ timeoutMs: 250 })).resolves.toBeNull();

    const connected = new FakeProvider();
    const release = broker.register(connected);
    const pending = broker.capture({ timeoutMs: 250 });
    release();
    await expect(pending).resolves.toBeNull();
  });

  it("ignores unrelated and stale text messages", async () => {
    const broker = new DecodedFrameBroker();
    const provider = new FakeProvider();
    broker.register(provider);
    const pending = broker.capture({ timeoutMs: 250 });
    const { id } = request(provider);

    expect(broker.receive(provider, JSON.stringify({ type: "other" }))).toBe(false);
    expect(broker.receive(provider, frameResponse("0".repeat(32)))).toBe(true);
    broker.receive(provider, frameResponse(id));
    await expect(pending).resolves.not.toBeNull();
  });
});
