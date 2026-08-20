import { ServeDroidError, type SessionInfo } from "@serve-droid/core";

const SESSION_REQUEST_TIMEOUT_MS = 1_500;

type SessionFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function selectLiveSession(
  sessions: readonly SessionInfo[],
  selector?: string,
): SessionInfo {
  const needle = selector?.trim();
  const matches = needle
    ? sessions.filter(
        (session) =>
          session.device.serial === needle ||
          session.device.model?.toLocaleLowerCase() === needle.toLocaleLowerCase(),
      )
    : [...sessions];

  if (matches.length === 0) {
    throw new ServeDroidError(
      "SESSION_NOT_FOUND",
      needle ? `No live session matches '${needle}'.` : "No live serve-droid session exists.",
    );
  }
  if (matches.length !== 1) {
    throw new ServeDroidError(
      "DEVICE_AMBIGUOUS",
      needle
        ? `Session selector '${needle}' matches more than one live session.`
        : "More than one live session exists; pass a device selector.",
    );
  }
  return matches[0]!;
}

export function validateSessionCursor(value: string): string {
  if (!/^\d+$/u.test(value)) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      "Activity cursor must be a non-negative integer.",
    );
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) {
    throw new ServeDroidError("INVALID_ARGUMENT", "Activity cursor exceeds the supported range.");
  }
  return String(cursor);
}

export async function fetchSessionJson<T>(
  session: SessionInfo,
  path: string,
  fetcher: SessionFetcher = fetch,
): Promise<T> {
  const base = new URL(session.url);
  const target = new URL(path, base);
  if (target.origin !== base.origin) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      "Session request must remain on the live session.",
    );
  }

  let response: Response;
  try {
    response = await fetcher(target, {
      headers: { authorization: `Bearer ${session.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ServeDroidError(
      "TRANSPORT_FAILED",
      error instanceof Error
        ? `Live session request failed: ${error.message}`
        : "Live session request failed.",
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ServeDroidError("TRANSPORT_FAILED", "Live session returned malformed JSON.");
  }
  if (!response.ok) {
    const record =
      value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
    const errorValue = record && "error" in record ? record.error : null;
    const errorRecord =
      errorValue !== null && typeof errorValue === "object" && !Array.isArray(errorValue)
        ? errorValue
        : null;
    const message =
      errorRecord && "message" in errorRecord && typeof errorRecord.message === "string"
        ? errorRecord.message
        : `Live session request failed with HTTP ${response.status}.`;
    throw new ServeDroidError("TRANSPORT_FAILED", message);
  }
  return value as T;
}
