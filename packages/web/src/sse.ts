export interface SseEvent {
  event: string;
  data: string;
}

export interface SseParser {
  push(chunk: string): void;
  finish(): void;
}

function parseFrame(frame: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
  let buffer = "";

  const drain = (flush: boolean): void => {
    buffer = buffer.replace(/\r\n/gu, "\n");
    while (true) {
      const separator = buffer.indexOf("\n\n");
      if (separator < 0) break;
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const parsed = parseFrame(frame);
      if (parsed) onEvent(parsed);
    }
    if (flush && buffer.trim()) {
      const parsed = parseFrame(buffer);
      buffer = "";
      if (parsed) onEvent(parsed);
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      drain(false);
    },
    finish() {
      drain(true);
    },
  };
}
