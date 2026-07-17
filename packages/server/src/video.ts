import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import { AndroidAvcLevel, AndroidAvcProfile, ScrcpyCodecOptions } from "@yume-chan/scrcpy";
import { ServeDroidError } from "@serve-droid/core";
import type { Adb } from "@yume-chan/adb";

export interface VideoSourceEvents {
  data: [Buffer];
  audioData: [{ data: Buffer; pts: bigint }];
  audioState: [AudioState];
  error: [Error];
  restart: [{ attempt: number; maxAttempts: number }];
  close: [];
  size: [{ width: number; height: number }];
}

export interface AudioState {
  enabled: boolean;
  available: boolean;
  codec: "opus" | null;
  reason?: string;
}

export interface VideoSource extends EventEmitter<VideoSourceEvents> {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const MAX_VIDEO_RESTARTS = 1;

export class RestartingVideoSource extends EventEmitter<VideoSourceEvents> implements VideoSource {
  #source: VideoSource | undefined;
  #generation = 0;
  #restartAttempts = 0;
  #started = false;
  #stopped = false;
  #recovering = false;

  public constructor(private readonly createSource: () => VideoSource) {
    super();
  }

  public async start(): Promise<void> {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    try {
      await this.#startSource();
    } catch (error) {
      if (!this.#consumeRestart()) throw this.#terminalError(error);
      try {
        await this.#startSource();
      } catch (retryError) {
        throw this.#terminalError(retryError);
      }
    }
  }

  public async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const source = this.#detachSource();
    await source?.stop().catch(() => undefined);
    this.emit("close");
  }

  async #startSource(): Promise<void> {
    const source = this.createSource();
    const generation = ++this.#generation;
    this.#source = source;
    source.on("data", (chunk) => this.#forward(source, generation, "data", chunk));
    source.on("audioData", (packet) => this.#forward(source, generation, "audioData", packet));
    source.on("audioState", (state) => this.#forward(source, generation, "audioState", state));
    source.on("size", (size) => this.#forward(source, generation, "size", size));
    source.on("error", (error) => {
      if (this.#isCurrent(source, generation)) void this.#recover(source, error);
    });
    try {
      await source.start();
    } catch (error) {
      if (this.#isCurrent(source, generation)) this.#detachSource();
      await source.stop().catch(() => undefined);
      throw error;
    }
  }

  #forward(
    source: VideoSource,
    generation: number,
    event: "data" | "audioData" | "audioState" | "size",
    value: Buffer | { data: Buffer; pts: bigint } | AudioState | { width: number; height: number },
  ): void {
    if (!this.#isCurrent(source, generation)) return;
    if (event === "data") this.emit("data", value as Buffer);
    else if (event === "audioData") this.emit("audioData", value as { data: Buffer; pts: bigint });
    else if (event === "audioState") this.emit("audioState", value as AudioState);
    else this.emit("size", value as { width: number; height: number });
  }

  #isCurrent(source: VideoSource, generation: number): boolean {
    return !this.#stopped && this.#source === source && this.#generation === generation;
  }

  #detachSource(): VideoSource | undefined {
    const source = this.#source;
    this.#source = undefined;
    this.#generation += 1;
    return source;
  }

  #consumeRestart(): boolean {
    if (this.#restartAttempts >= MAX_VIDEO_RESTARTS) return false;
    this.#restartAttempts += 1;
    this.emit("restart", { attempt: this.#restartAttempts, maxAttempts: MAX_VIDEO_RESTARTS });
    return true;
  }

  async #recover(source: VideoSource, error: Error): Promise<void> {
    if (this.#recovering || this.#stopped || this.#source !== source) return;
    this.#recovering = true;
    this.#detachSource();
    await source.stop().catch(() => undefined);
    try {
      if (!this.#consumeRestart()) {
        this.emit("error", this.#terminalError(error));
        return;
      }
      try {
        await this.#startSource();
      } catch (restartError) {
        this.emit("error", this.#terminalError(restartError));
      }
    } finally {
      this.#recovering = false;
    }
  }

  #terminalError(error: unknown): ServeDroidError {
    const cause = error instanceof Error ? error.message : String(error);
    return new ServeDroidError(
      "TRANSPORT_FAILED",
      `scrcpy video helper failed after ${this.#restartAttempts} restart attempt.`,
      { restartAttempts: this.#restartAttempts, maxRestarts: MAX_VIDEO_RESTARTS, cause },
    );
  }
}

const SCRCPY_VERSION = "3.3.3";
const REMOTE_SERVER = `/data/local/tmp/serve-droid-scrcpy-server-${SCRCPY_VERSION}`;
type TangoClient = AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>;
type TangoVideoStream = Awaited<TangoClient["videoStream"]>;
type TangoAudioStream = Exclude<Awaited<TangoClient["audioStream"]>, undefined>;
type TangoOutputStream = TangoClient["output"];

function adbServerAddress(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const socket = env.ADB_SERVER_SOCKET?.match(/^tcp:([^:]+):(\d+)$/u);
  if (socket) return { host: socket[1]!, port: Number(socket[2]) };
  return { host: "127.0.0.1", port: Number(env.ANDROID_ADB_SERVER_PORT) || 5037 };
}

async function bundledServerPath(): Promise<string> {
  const filename = `scrcpy-server-v${SCRCPY_VERSION}`;
  const candidates = [
    process.env.SCRCPY_SERVER_PATH,
    resolve(import.meta.dirname, "../vendor", filename),
    resolve(import.meta.dirname, "../packages/server/vendor", filename),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported package layout.
    }
  }
  throw new Error(`Bundled scrcpy server ${SCRCPY_VERSION} was not found.`);
}

/**
 * Starts the official scrcpy server through Tango ADB and relays its parsed H.264 packets.
 * Video bytes are never decoded or re-encoded on the host.
 */
export class ScrcpyH264Source extends EventEmitter<VideoSourceEvents> implements VideoSource {
  #adb: Adb | undefined;
  #client: TangoClient | undefined;
  #reader: { cancel(): Promise<void>; releaseLock(): void } | undefined;
  #stopped = false;

  public constructor(
    private readonly serial: string,
    private readonly captureAudio = false,
  ) {
    super();
  }

  public async start(): Promise<void> {
    if (this.#client || this.#stopped) return;
    const serverPath = await bundledServerPath();
    const server = new AdbServerClient(new AdbServerNodeTcpConnector(adbServerAddress()));
    const adb = await server.createAdb({ serial: this.serial });
    this.#adb = adb;
    const file = Readable.toWeb(createReadStream(serverPath));
    await AdbScrcpyClient.pushServer(adb, file as never, REMOTE_SERVER);
    const options = new AdbScrcpyOptionsLatest({
      video: true,
      audio: this.captureAudio,
      audioCodec: "opus",
      audioSource: "playback",
      control: true,
      videoCodec: "h264",
      videoCodecOptions: new ScrcpyCodecOptions({
        profile: AndroidAvcProfile.Baseline,
        level: AndroidAvcLevel.Level4,
        maxBframes: 0,
      }),
      videoBitRate: 4_000_000,
      maxFps: 60,
      maxSize: 1920,
      sendFrameMeta: true,
      sendCodecMeta: true,
      cleanup: true,
      logLevel: "info",
    });
    const client = await AdbScrcpyClient.start(adb, REMOTE_SERVER, options);
    this.#client = client;
    void this.#consumeOutput(client.output);
    const video = await client.videoStream;
    this.emit("size", { width: video.width, height: video.height });
    video.sizeChanged((size) => this.emit("size", size));
    void this.#consumeVideo(video);
    if (this.captureAudio) {
      void this.#startAudio(client);
    } else {
      this.emit("audioState", { enabled: false, available: false, codec: null });
    }
    void client.exited
      .then(() => {
        if (!this.#stopped) this.emit("error", new Error("scrcpy server exited unexpectedly."));
      })
      .catch((error: unknown) =>
        this.emit("error", error instanceof Error ? error : new Error(String(error))),
      );
  }

  public async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.#reader?.cancel().catch(() => undefined);
    await this.#client?.close().catch(() => undefined);
    await this.#adb?.close().catch(() => undefined);
    this.#reader = undefined;
    this.#client = undefined;
    this.#adb = undefined;
    this.emit("close");
  }

  async #consumeVideo(video: TangoVideoStream): Promise<void> {
    const reader = video.stream.getReader();
    this.#reader = reader;
    try {
      while (!this.#stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        this.emit("data", Buffer.from(value.data));
      }
    } catch (error) {
      if (!this.#stopped)
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
    } finally {
      reader.releaseLock();
    }
  }

  async #consumeAudio(audio: Extract<TangoAudioStream, { type: "success" }>): Promise<void> {
    const reader = audio.stream.getReader();
    try {
      while (!this.#stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type !== "data" || value.pts === undefined) continue;
        this.emit("audioData", { data: Buffer.from(value.data), pts: value.pts });
      }
    } catch (error) {
      if (!this.#stopped)
        this.emit("audioState", {
          enabled: true,
          available: false,
          codec: null,
          reason: error instanceof Error ? error.message : String(error),
        });
    } finally {
      reader.releaseLock();
    }
  }

  async #startAudio(client: TangoClient): Promise<void> {
    try {
      const audio = await client.audioStream;
      if (!audio || audio.type === "disabled") {
        this.emit("audioState", {
          enabled: true,
          available: false,
          codec: null,
          reason: "Android audio capture is unavailable on this device.",
        });
      } else if (audio.type === "errored") {
        this.emit("audioState", {
          enabled: true,
          available: false,
          codec: null,
          reason: "The device could not start the requested Opus audio encoder.",
        });
      } else {
        this.emit("audioState", { enabled: true, available: true, codec: "opus" });
        void this.#consumeAudio(audio);
      }
    } catch (error) {
      this.emit("audioState", {
        enabled: true,
        available: false,
        codec: null,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #consumeOutput(stream: TangoOutputStream): Promise<void> {
    const reader = stream.getReader();
    try {
      while (!this.#stopped) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (error) {
      if (!this.#stopped)
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
    } finally {
      reader.releaseLock();
    }
  }
}

export const SCRCPY_SERVER_VERSION = SCRCPY_VERSION;
export const SCRCPY_SERVER_SHA256 =
  "7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0";
