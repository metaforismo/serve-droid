import type { ServerResponse } from "node:http";

export type FileOperation = "install" | "push";
export type FileProgressPhase = "installing" | "pushing" | "completed" | "failed";

export interface FileProgressEvent {
  schemaVersion: 1;
  type: "file-progress";
  operation: FileOperation;
  phase: FileProgressPhase;
  message: string;
}

export function acceptsFileProgressStream(accept: string | string[] | undefined): boolean {
  return String(accept ?? "")
    .split(",")
    .some((value) => value.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream");
}

export function fileProgressEvent(
  operation: FileOperation,
  phase: FileProgressPhase,
  message: string,
): FileProgressEvent {
  return { schemaVersion: 1, type: "file-progress", operation, phase, message };
}

export function startFileProgressStream(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });
}

export function writeFileProgressFrame(
  response: Pick<ServerResponse, "write">,
  event: "progress" | "result" | "error",
  body: unknown,
): boolean {
  return response.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
}
