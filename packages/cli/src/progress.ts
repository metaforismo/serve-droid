export interface CliProgressOptions {
  json?: boolean;
  quiet?: boolean;
}

export interface CliProgressEvent {
  schemaVersion: 1;
  type: "progress";
  operation: "install" | "push";
  phase: "installing" | "pushing" | "completed";
  step: 1 | 2;
  total: 2;
  message: string;
}

export function cliProgressEvent(
  operation: "install" | "push",
  phase: CliProgressEvent["phase"],
  step: 1 | 2,
  message: string,
): CliProgressEvent {
  return { schemaVersion: 1, type: "progress", operation, phase, step, total: 2, message };
}

export function writeCliProgress(
  options: CliProgressOptions,
  event: CliProgressEvent,
  write: (value: string) => void = (value) => void process.stderr.write(value),
): void {
  if (options.quiet) return;
  write(options.json ? `${JSON.stringify(event)}\n` : `${event.message}\n`);
}
