interface DecoderOptions {
  canvas: HTMLCanvasElement;
  onFrame: () => void;
  onError: (message: string) => void;
}

function startCodes(data: Uint8Array): number[] {
  const positions: number[] = [];
  for (let index = 0; index < data.length - 3; index += 1) {
    if (
      data[index] === 0 &&
      data[index + 1] === 0 &&
      (data[index + 2] === 1 || (data[index + 2] === 0 && data[index + 3] === 1))
    ) {
      positions.push(index);
    }
  }
  return positions;
}

export class H264CanvasPlayer {
  readonly #decoder: VideoDecoder;
  readonly #onFrame: () => void;
  #buffer = new Uint8Array();
  #timestamp = 0;

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
      error: (error) => onError(error.message),
    });
    this.#decoder.configure({
      codec: "avc1.42E01E",
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
    });
  }

  public push(chunk: ArrayBuffer): void {
    const next = new Uint8Array(this.#buffer.length + chunk.byteLength);
    next.set(this.#buffer);
    next.set(new Uint8Array(chunk), this.#buffer.length);
    this.#buffer = next;
    const positions = startCodes(this.#buffer);
    if (positions.length < 2) return;
    for (let index = 0; index < positions.length - 1; index += 1) {
      const start = positions[index]!;
      const end = positions[index + 1]!;
      const unit = this.#buffer.slice(start, end);
      const prefix = unit[2] === 1 ? 3 : 4;
      const type = (unit[prefix] ?? 0) & 0x1f;
      if (type === 7 || type === 8 || type === 5 || (type >= 1 && type <= 5)) {
        this.#decoder.decode(
          new EncodedVideoChunk({
            type: type === 5 ? "key" : "delta",
            timestamp: (this.#timestamp += 33_333),
            data: unit,
          }),
        );
      }
    }
    this.#buffer = this.#buffer.slice(positions.at(-1));
  }

  public close(): void {
    this.#decoder.close();
  }
}
