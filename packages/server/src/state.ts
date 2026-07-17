import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@serve-droid/core";

function stateDirectory(): string {
  return join(tmpdir(), "serve-droid");
}

function safeSerial(serial: string): string {
  return serial.replaceAll(/[^a-zA-Z0-9_.-]/gu, "_");
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

export async function readSessionStates(): Promise<SessionInfo[]> {
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
        try {
          return JSON.parse(await readFile(join(stateDirectory(), name), "utf8")) as SessionInfo;
        } catch {
          return null;
        }
      }),
  );
  return sessions.filter((session): session is SessionInfo => session !== null);
}
