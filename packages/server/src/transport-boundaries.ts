import type { ServerResponse } from "node:http";
import { basename } from "node:path";
import { ServeDroidError, type LogEntry } from "@serve-droid/core";

function invalidJson(message: string): never {
  throw new ServeDroidError("INVALID_ARGUMENT", message);
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    invalidJson("Request body must be valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidJson("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function decodeUploadName(encodedName: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedName);
  } catch {
    throw new ServeDroidError("INVALID_ARGUMENT", "x-file-name must be valid URI-encoded text.");
  }
  const name = basename(decoded);
  if (!name || name === "." || name === ".." || name.includes("\0")) {
    throw new ServeDroidError("INVALID_ARGUMENT", "x-file-name is required.");
  }
  return name;
}

function numericCursor(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d+$/u.test(raw)) return 0;
  const cursor = Number(raw);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

export function sseResumeCursor(queryCursor: string, lastEventId: string | string[] | undefined) {
  return String(Math.max(numericCursor(queryCursor), numericCursor(lastEventId)));
}

type SseResponse = Pick<ServerResponse, "write" | "end">;

export function writeSseLogFrame(response: SseResponse, entry: LogEntry): boolean {
  const writable = response.write(`id: ${entry.cursor}\ndata: ${JSON.stringify(entry)}\n\n`);
  if (!writable) response.end();
  return writable;
}
