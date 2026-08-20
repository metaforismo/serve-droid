import type { SessionInfo } from "@serve-droid/core";
import { describe, expect, it, vi } from "vitest";
import {
  fetchSessionJson,
  selectLiveSession,
  validateSessionCursor,
} from "../src/session-client.js";

function session(serial: string, model: string, token = `token-${serial}`): SessionInfo {
  return {
    schemaVersion: 1,
    pid: 1234,
    host: "127.0.0.1",
    port: serial === "emulator-5554" ? 41001 : 41002,
    url: `http://127.0.0.1:${serial === "emulator-5554" ? 41001 : 41002}`,
    token,
    startedAt: "2026-08-20T01:00:00.000Z",
    device: {
      serial,
      state: "device",
      kind: serial.startsWith("emulator-") ? "emulator" : "physical",
      model,
      apiLevel: 35,
    },
    display: { width: 1080, height: 2400, orientation: "portrait" },
  } as SessionInfo;
}

describe("live-session client", () => {
  it("selects one session by exact serial or case-insensitive model", () => {
    const sessions = [session("emulator-5554", "Pixel 9 Pro"), session("R5CT123", "Galaxy S25")];
    expect(selectLiveSession(sessions, "emulator-5554").device.serial).toBe("emulator-5554");
    expect(selectLiveSession(sessions, "pixel 9 pro").device.serial).toBe("emulator-5554");
  });

  it("requires an explicit selector when several sessions are live", () => {
    const sessions = [session("emulator-5554", "Pixel"), session("emulator-5556", "Pixel")];
    expect(() => selectLiveSession(sessions)).toThrow(/pass a device selector/u);
    expect(() => selectLiveSession(sessions, "Pixel")).toThrow(/more than one/u);
    expect(() => selectLiveSession([], "missing")).toThrow(/No live session matches/u);
  });

  it("validates activity cursors without silently rounding", () => {
    expect(validateSessionCursor("00042")).toBe("42");
    expect(validateSessionCursor("0")).toBe("0");
    expect(() => validateSessionCursor("-1")).toThrow(/non-negative integer/u);
    expect(() => validateSessionCursor("1.5")).toThrow(/non-negative integer/u);
    expect(() => validateSessionCursor(String(Number.MAX_SAFE_INTEGER + 1))).toThrow(
      /supported range/u,
    );
  });

  it("sends the stored bearer token only to the live session origin", async () => {
    const live = session("emulator-5554", "Pixel", "secret-session-token");
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${live.url}/api/v1/activity?since=7`);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-session-token");
      return new Response(JSON.stringify({ schemaVersion: 1, events: [], nextCursor: "7" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      fetchSessionJson<{ nextCursor: string }>(live, "/api/v1/activity?since=7", fetcher),
    ).resolves.toMatchObject({ nextCursor: "7" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(fetchSessionJson(live, "https://example.com/steal", fetcher)).rejects.toThrow(
      /remain on the live session/u,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("contains transport failures without exposing the bearer token", async () => {
    const live = session("emulator-5554", "Pixel", "never-print-this-token");
    const fetcher = vi.fn(async () => new Response("not json", { status: 500 }));
    await expect(fetchSessionJson(live, "/api/v1/activity", fetcher)).rejects.not.toThrow(
      /never-print-this-token/u,
    );
    await expect(fetchSessionJson(live, "/api/v1/activity", fetcher)).rejects.toThrow(
      /malformed JSON/u,
    );
  });
});
