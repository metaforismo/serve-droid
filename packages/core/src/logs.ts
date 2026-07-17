import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AdbRunner } from "./adb.js";
import type { LogEntry } from "./types.js";

const MAX_LOG_LINE_LENGTH = 64 * 1024;
const THREADTIME_FIXED_DIGITS = [0, 1, 3, 4, 6, 7, 9, 10, 12, 13] as const;

interface ThreadtimeFields {
  timestamp: string;
  pid: string;
  tid: string;
  priority: string;
  tag: string;
  message: string;
}

function isDigit(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code >= 48 && code <= 57;
}

function parseThreadtime(line: string): ThreadtimeFields | null {
  if (line.length > MAX_LOG_LINE_LENGTH || line.length < 22) return null;
  if (
    THREADTIME_FIXED_DIGITS.some((index) => !isDigit(line, index)) ||
    line[2] !== "-" ||
    line[5] !== " " ||
    line[8] !== ":" ||
    line[11] !== ":" ||
    line[14] !== "."
  )
    return null;

  let index = 15;
  const fractionStart = index;
  while (isDigit(line, index)) index += 1;
  if (index === fractionStart) return null;
  const timestamp = line.slice(0, index);

  const readSpaces = (): boolean => {
    const start = index;
    while (line[index] === " ") index += 1;
    return index > start;
  };
  const readNumber = (): string | null => {
    const start = index;
    while (isDigit(line, index)) index += 1;
    return index > start ? line.slice(start, index) : null;
  };

  if (!readSpaces()) return null;
  const pid = readNumber();
  if (!pid || !readSpaces()) return null;
  const tid = readNumber();
  if (!tid || !readSpaces()) return null;
  const priority = line[index] ?? "";
  if (priority.length !== 1 || !"VDIWEAF".includes(priority)) return null;
  index += 1;
  if (!readSpaces()) return null;

  const colon = line.indexOf(":", index);
  if (colon < 0) return null;
  const tag = line.slice(index, colon).trim();
  if (!tag) return null;
  const messageStart = line[colon + 1] === " " ? colon + 2 : colon + 1;
  return { timestamp, pid, tid, priority, tag, message: line.slice(messageStart) };
}

export function parseLogLine(
  line: string,
  cursor: number,
  year = new Date().getFullYear(),
): LogEntry | null {
  const fields = parseThreadtime(line);
  if (!fields) return null;
  return {
    cursor: String(cursor),
    timestamp: new Date(
      `${year}-${fields.timestamp.slice(0, 5)}T${fields.timestamp.slice(6)}Z`,
    ).toISOString(),
    pid: Number(fields.pid),
    tid: Number(fields.tid),
    priority: fields.priority,
    tag: fields.tag,
    message: fields.message,
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
