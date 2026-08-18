import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, type SessionInfo } from "@serve-droid/core";

const SESSION_PROBE_TIMEOUT_MS = 1_500;

function stateDirectory(): string {
  return join(tmpdir(), "serve-droid");
}

function safeSerial(serial: string): string {
  return serial.replaceAll(/[^a-zA-Z0-9_.-]/gu, "_");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function storedSession(value: unknown): SessionInfo | null {
  const session = record(value);
  const device = record(session?.device);
  const display = record(session?.display);
  if (!session || !device || !display || session.schemaVersion !== SCHEMA_VERSION) return null;
  if (
    typeof device.serial !== "string" ||
    device.serial.length === 0 ||
    device.serial.length > 512 ||
    device.state !== "device" ||
    (device.kind !== "emulator" && device.kind !== "physical") ||
    !Number.isInteger(session.pid) ||
    Number(session.pid) <= 0 ||
    typeof session.host !== "string" ||
    !Number.isInteger(session.port) ||
    Number(session.port) < 1 ||
    Number(session.port) > 65_535 ||
    typeof session.url !== "string" ||
    typeof session.token !== "string" ||
    session.token.length === 0 ||
    session.token.length > 4_096 ||
    typeof session.startedAt !== "string" ||
    !Number.isFinite(Date.parse(session.startedAt)) ||
    !Number.isInteger(display.width) ||
    Number(display.width) < 1 ||
    !Number.isInteger(display.height) ||
    Number(display.height) < 1 ||
    (display.orientation !== "portrait" &&
      display.orientation !== "landscape-left" &&
      display.orientation !== "landscape-right")
  ) {
    return null;
  }
  try {
    const url = new URL(session.url);
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash ||
      Number(url.port) !== session.port
    ) {
      return null;
    }
  } catch {
    return null;
  }
  if (session.recordingDirectory !== undefined && typeof session.recordingDirectory !== "string") {
    return null;
  }
  return session as unknown as SessionInfo;
}

function matchesPersistedIdentity(value: unknown, session: SessionInfo): boolean {
  const live = record(value);
  const device = record(live?.device);
  return Boolean(
    live &&
    device &&
    live.schemaVersion === session.schemaVersion &&
    live.pid === session.pid &&
    live.port === session.port &&
    live.url === session.url &&
    live.startedAt === session.startedAt &&
    device.serial === session.device.serial,
  );
}

export function statePath(serial: string): string {
  return join(stateDirectory(), `session-${safeSerial(serial)}.json`);
}

export async function writeSessionState(session: SessionInfo): Promise<void> {
  await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(statePath(session.device.serial), `${JSON.stringify(session)}\n`, {
    mode: 0o600,
  });
}

export async function removeSessionState(serial: string): Promise<void> {
  await rm(statePath(serial), { force: true });
}

export async function verifySessionState(
  session: SessionInfo,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(`${session.url}/api/v1/session`, {
      headers: { authorization: `Bearer ${session.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(SESSION_PROBE_TIMEOUT_MS),
    });
    return response.ok && matchesPersistedIdentity(await response.json(), session);
  } catch {
    return false;
  }
}

export async function readSessionStates(fetcher: typeof fetch = fetch): Promise<SessionInfo[]> {
  let names: string[];
  try {
    names = await readdir(stateDirectory());
  } catch {
    return [];
  }

  const sessions = await Promise.all(
    names
      .filter((name) => /^session-.*\.json$/u.test(name))
      .map(async (name) => {
        const path = join(stateDirectory(), name);
        let session: SessionInfo | null = null;
        try {
          session = storedSession(JSON.parse(await readFile(path, "utf8")) as unknown);
        } catch {
          // Invalid persisted state is stale by definition.
        }
        if (session && (await verifySessionState(session, fetcher))) return session;
        await rm(path, { force: true }).catch(() => undefined);
        return null;
      }),
  );

  return sessions.filter((session): session is SessionInfo => session !== null);
}
