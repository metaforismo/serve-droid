import { describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, type SessionInfo } from "@serve-droid/core";
import { verifySessionState } from "../src/state.js";

const session: SessionInfo = {
  schemaVersion: SCHEMA_VERSION,
  device: {
    serial: "emulator-5554",
    state: "device",
    kind: "emulator",
    model: "Pixel",
    product: "sdk",
    manufacturer: "Google",
    apiLevel: 35,
    abi: "x86_64",
  },
  display: {
    width: 1080,
    height: 1920,
    density: 420,
    orientation: "portrait",
  },
  pid: 4242,
  host: "127.0.0.1",
  port: 43123,
  url: "http://127.0.0.1:43123",
  token: "stored-secret-token",
  startedAt: "2026-08-18T10:00:00.000Z",
};

function publicSession(overrides: Partial<SessionInfo> = {}): Record<string, unknown> {
  const value = { ...session, ...overrides } as Record<string, unknown>;
  delete value.token;
  return value;
}

describe("persisted session identity", () => {
  it("requires the persisted bearer token and an exact live session identity", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${session.url}/api/v1/session`);
      expect(init?.headers).toEqual({ authorization: `Bearer ${session.token}` });
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify(publicSession()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(verifySessionState(session, fetcher)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a healthy endpoint whose PID no longer matches the persisted session", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify(publicSession({ pid: session.pid + 1 })), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    await expect(verifySessionState(session, fetcher)).resolves.toBe(false);
  });

  it("rejects endpoints that do not authenticate the persisted token", async () => {
    const fetcher = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    await expect(verifySessionState(session, fetcher)).resolves.toBe(false);
  });

  it("rejects a different live session that reused the same port and PID", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify(
          publicSession({
            startedAt: "2026-08-18T10:05:00.000Z",
            device: { ...session.device, serial: "emulator-5556" },
          }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    await expect(verifySessionState(session, fetcher)).resolves.toBe(false);
  });
});
