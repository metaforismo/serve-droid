export interface AudioPlayer {
  push(packet: ArrayBuffer): void;
  close(): Promise<void>;
}

const AUDIO_HEADER_BYTES = 8;
const MAX_DECODE_QUEUE = 12;
const MAX_SCHEDULE_AHEAD_SECONDS = 0.5;
const MAX_RECONNECT_DELAY_MS = 5_000;

export function canQueueAudio(decodeQueueSize: number): boolean {
  return (
    Number.isInteger(decodeQueueSize) && decodeQueueSize >= 0 && decodeQueueSize < MAX_DECODE_QUEUE
  );
}

export function nextAudioReconnectDelay(currentDelayMs: number): number {
  return Math.min(MAX_RECONNECT_DELAY_MS, Math.max(250, currentDelayMs * 2));
}

export function scheduledAudioTime(currentTime: number, nextTime: number): number {
  if (nextTime < currentTime || nextTime > currentTime + MAX_SCHEDULE_AHEAD_SECONDS) {
    return currentTime + 0.03;
  }
  return nextTime;
}

export class OpusAudioPlayer implements AudioPlayer {
  readonly #context: AudioContext;
  readonly #decoder: AudioDecoder;
  readonly #onError: (message: string) => void;
  #nextTime = 0;
  #closed = false;

  public static async create(onError: (message: string) => void): Promise<OpusAudioPlayer> {
    if (typeof AudioDecoder === "undefined") {
      throw new Error("This browser does not provide the WebCodecs AudioDecoder API.");
    }
    const context = new AudioContext({ latencyHint: "interactive", sampleRate: 48_000 });
    await context.resume();
    return new OpusAudioPlayer(context, onError);
  }

  private constructor(context: AudioContext, onError: (message: string) => void) {
    this.#context = context;
    this.#onError = onError;
    this.#decoder = new AudioDecoder({
      output: (audio) => this.#play(audio),
      error: (error) => this.#onError(error.message),
    });
    this.#decoder.configure({ codec: "opus", sampleRate: 48_000, numberOfChannels: 2 });
  }

  public push(packet: ArrayBuffer): void {
    if (this.#closed || packet.byteLength <= AUDIO_HEADER_BYTES) return;
    if (!canQueueAudio(this.#decoder.decodeQueueSize)) return;
    const view = new DataView(packet);
    const timestamp = Number(view.getBigInt64(0, false));
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) return;
    this.#decoder.decode(
      new EncodedAudioChunk({
        type: "key",
        timestamp,
        data: packet.slice(AUDIO_HEADER_BYTES),
      }),
    );
  }

  #play(audio: AudioData): void {
    try {
      const buffer = this.#context.createBuffer(
        audio.numberOfChannels,
        audio.numberOfFrames,
        audio.sampleRate,
      );
      for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
        const samples = new Float32Array(audio.numberOfFrames);
        audio.copyTo(samples, { planeIndex: channel, format: "f32-planar" });
        buffer.copyToChannel(samples, channel);
      }
      const source = this.#context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.#context.destination);
      this.#nextTime = scheduledAudioTime(this.#context.currentTime, this.#nextTime);
      source.start(this.#nextTime);
      this.#nextTime += buffer.duration;
    } catch (error) {
      this.#onError(error instanceof Error ? error.message : String(error));
    } finally {
      audio.close();
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#decoder.state !== "closed") this.#decoder.close();
    await this.#context.close();
  }
}
