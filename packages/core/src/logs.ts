import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AdbRunner } from "./adb.js";
import type { LogEntry } from "./types.js";

const THREADTIME =
  /^(\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEAF])\s+([^:]+):\s?(.*)$/u;

export function parseLogLine(
  line: string,
  cursor: number,
  year = new Date().getFullYear(),
): LogEntry | null {
  const match = line.match(THREADTIME);
  if (!match) return null;
  return {
    cursor: String(cursor),
    timestamp: new Date(`${year}-${match[1]!.replace(/\s+/u, "T")}Z`).toISOString(),
    pid: Number(match[2]),
    tid: Number(match[3]),
    priority: match[4]!,
    tag: match[5]!.trim(),
    message: match[6]!,
  };
}

export class LogBuffer extends EventEmitter {
  readonly #entries: LogEntry[] = [];
  readonly #limit: number;
  #cursor = 0;
  #process: ChildProcessWithoutNullStreams | undefined;
  #partial = "";

  public constructor(limit = 5_000) {
    super();
    this.#limit = limit;
  }

  public start(adb: AdbRunner, serial: string): void {
    if (this.#process) return;
    this.#process = adb.spawn(["logcat", "-v", "threadtime"], { serial });
    this.#process.stdout.setEncoding("utf8").on("data", (chunk: string) => this.#consume(chunk));
    this.#process.once("close", () => {
      this.#process = undefined;
      this.emit("close");
    });
  }

  public stop(): void {
    this.#process?.kill();
    this.#process = undefined;
  }

  public read(since = "0", pid?: number): { entries: LogEntry[]; nextCursor: string } {
    const cursor = Number.parseInt(since, 10) || 0;
    return {
      entries: this.#entries.filter(
        (entry) => Number(entry.cursor) > cursor && (!pid || entry.pid === pid),
      ),
      nextCursor: String(this.#cursor),
    };
  }

  #consume(chunk: string): void {
    const lines = `${this.#partial}${chunk}`.split(/\r?\n/u);
    this.#partial = lines.pop() ?? "";
    for (const line of lines) {
      const entry = parseLogLine(line, ++this.#cursor);
      if (!entry) continue;
      this.#entries.push(entry);
      if (this.#entries.length > this.#limit)
        this.#entries.splice(0, this.#entries.length - this.#limit);
      this.emit("entry", entry);
    }
  }
}
