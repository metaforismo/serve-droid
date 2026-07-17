import type { TinyH264Decoder } from "@yume-chan/scrcpy-decoder-tinyh264";

interface DecoderOptions {
  canvas: HTMLCanvasElement;
  onFrame: () => void;
  onError: (message: string) => void;
}

export type DecoderBackend = "webcodecs" | "tinyh264";

export interface CanvasPlayer {
  readonly backend: DecoderBackend;
  push(chunk: ArrayBuffer): void;
  close(): void;
}

type H264Packet =
  | { type: "configuration"; data: Uint8Array }
  | { type: "data"; data: Uint8Array; keyframe: boolean };

function startCodes(data: Uint8Array): number[] {
  const positions: number[] = [];
  for (let index = 0; index < data.length - 2; index += 1) {
    if (data[index] !== 0 || data[index + 1] !== 0) continue;
    if (data[index + 2] === 1) {
      positions.push(index);
      index += 2;
    } else if (data[index + 2] === 0 && data[index + 3] === 1) {
      positions.push(index);
      index += 3;
    }
  }
  return positions;
}

export function firstNalUnitType(data: Uint8Array): number | null {
  return nalUnitTypes(data)[0] ?? null;
}

export function nalUnitTypes(data: Uint8Array): number[] {
  return startCodes(data).flatMap((position) => {
    const prefix = data[position + 2] === 1 ? 3 : 4;
    const header = data[position + prefix];
    return header === undefined ? [] : [header & 0x1f];
  });
}

export class H264CanvasPlayer implements CanvasPlayer {
  public readonly backend = "webcodecs" as const;
  readonly #decoder: VideoDecoder;
  readonly #onFrame: () => void;
  #configuration = new Uint8Array();
  #timestamp = 0;
  #failed = false;

  public constructor({ canvas, onFrame, onError }: DecoderOptions) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D is unavailable.");
    if (!("VideoDecoder" in window))
      throw new Error("WebCodecs is unavailable. Use current Chrome or Edge.");
    this.#onFrame = onFrame;
    this.#decoder = new VideoDecoder({
      output: (frame) => {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        context.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frame.close();
        this.#onFrame();
      },
      error: (error) => {
        this.#failed = true;
        onError(error.message);
      },
    });
    this.#decoder.configure({
      codec: "avc1.42C028",
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
    });
  }

  public push(chunk: ArrayBuffer): void {
    if (this.#failed) return;
    const data = new Uint8Array(chunk);
    const types = nalUnitTypes(data);
    const hasFrame = types.some((type) => type >= 1 && type <= 5);
    const keyframe = types.includes(5);
    if (!hasFrame) {
      if (types.includes(7) || types.includes(8)) this.#configuration = data.slice();
      return;
    }
    let payload = data;
    if (keyframe && this.#configuration.length) {
      payload = new Uint8Array(this.#configuration.length + data.length);
      payload.set(this.#configuration);
      payload.set(data, this.#configuration.length);
    }
    this.#decoder.decode(
      new EncodedVideoChunk({
        type: keyframe ? "key" : "delta",
        timestamp: (this.#timestamp += 33_333),
        data: payload,
      }),
    );
  }

  public close(): void {
    if (this.#decoder.state !== "closed") this.#decoder.close();
  }
}

class TinyH264CanvasPlayer implements CanvasPlayer {
  public readonly backend = "tinyh264" as const;
  readonly #decoder;
  readonly #writer: WritableStreamDefaultWriter<H264Packet>;
  readonly #frameTimer: number;
  readonly #onError: (message: string) => void;
  #lastFrames = 0;
  #queued = 0;
  #closed = false;

  public constructor(decoder: InstanceType<typeof TinyH264Decoder>, options: DecoderOptions) {
    this.#decoder = decoder;
    this.#writer = decoder.writable.getWriter() as WritableStreamDefaultWriter<H264Packet>;
    this.#onError = options.onError;
    this.#frameTimer = window.setInterval(() => {
      const rendered = decoder.framesRendered;
      const count = Math.min(10, rendered - this.#lastFrames);
      this.#lastFrames = rendered;
      for (let index = 0; index < count; index += 1) options.onFrame();
    }, 50);
  }

  public push(chunk: ArrayBuffer): void {
    if (this.#closed) return;
    const data = new Uint8Array(chunk);
    const types = nalUnitTypes(data);
    if (!types.length) return;
    const configuration = types.includes(7) || types.includes(8);
    const keyframe = types.includes(5);
    if (!configuration && !keyframe && this.#queued >= 8) return;
    const packet: H264Packet = configuration
      ? { type: "configuration", data }
      : { type: "data", data, keyframe };
    this.#queued += 1;
    void this.#writer
      .write(packet)
      .catch((error: unknown) =>
        this.#onError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        this.#queued -= 1;
      });
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    window.clearInterval(this.#frameTimer);
    void this.#writer.close().catch(() => undefined);
    this.#decoder.dispose();
  }
}

export async function createH264CanvasPlayer(options: DecoderOptions): Promise<CanvasPlayer> {
  if (typeof VideoDecoder !== "undefined") return new H264CanvasPlayer(options);
  if (!("WebAssembly" in window) || !("Worker" in window)) {
    throw new Error(
      "Video decoding requires WebCodecs or a browser with WebAssembly and Web Workers.",
    );
  }
  const { TinyH264Decoder } = await import("@yume-chan/scrcpy-decoder-tinyh264");
  return new TinyH264CanvasPlayer(new TinyH264Decoder({ canvas: options.canvas }), options);
}
