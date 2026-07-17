import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  ServeDroidError,
  type DeviceSummary,
  type SessionInfo,
} from "@serve-droid/core";
import { GridCoordinator, GridDashboard } from "../src/grid.js";

function device(serial: string, state: DeviceSummary["state"] = "device"): DeviceSummary {
  return {
    serial,
    state,
    kind: "physical",
    model: serial,
    product: null,
    manufacturer: "test",
    apiLevel: 35,
    abi: "arm64-v8a",
  };
}

function session(value: DeviceSummary): SessionInfo {
  return {
    schemaVersion: SCHEMA_VERSION,
    device: value,
    display: { width: 1080, height: 1920, density: 420, orientation: "portrait" },
    pid: 1,
    host: "127.0.0.1",
    port: 9000,
    url: `http://127.0.0.1:9000/${value.serial}`,
    token: `secret-${value.serial}`,
    startedAt: "2026-07-17T00:00:00.000Z",
  };
}

describe("multi-device grid", () => {
  it("enforces explicit hard limits and unique selectors", () => {
    expect(() => new GridCoordinator([device("a"), device("b")], 1, async () => never())).toThrow(
      /exceed/u,
    );
    expect(() => new GridCoordinator([device("a"), device("a")], 2, async () => never())).toThrow(
      /unique/u,
    );
  });

  it("isolates child tokens and survives partial startup failure", async () => {
    const stopped: string[] = [];
    const coordinator = new GridCoordinator(
      [device("good"), device("offline", "offline"), device("broken")],
      3,
      async (value) => {
        if (value.serial === "broken") throw new Error("helper failed");
        return {
          session: session(value),
          stop: async () => {
            stopped.push(value.serial);
          },
        };
      },
    );
    const snapshot = await coordinator.start();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).not.toHaveProperty("token");
    expect(snapshot.failures).toEqual([
      { serial: "offline", message: "Device is offline." },
      { serial: "broken", message: "Device session failed." },
    ]);
    expect(coordinator.takeOver("good").activeSerial).toBe("good");
    expect(() => coordinator.takeOver("missing")).toThrow(ServeDroidError);
    await coordinator.stop();
    expect(stopped).toEqual(["good"]);
  });

  it("requires bearer authentication for grid state and takeover", async () => {
    const coordinator = new GridCoordinator([device("a")], 1, async (value) => ({
      session: session(value),
      stop: async () => undefined,
    }));
    await coordinator.start();
    const dashboard = new GridDashboard(coordinator);
    const url = await dashboard.start();
    try {
      expect((await fetch(`${url}/api/v1/grid`)).status).toBe(401);
      const authenticated = await fetch(`${url}/api/v1/grid`, {
        headers: { authorization: `Bearer ${dashboard.token}` },
      });
      expect(authenticated.status).toBe(200);
      const takeover = await fetch(`${url}/api/v1/takeover`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${dashboard.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ serial: "a" }),
      });
      expect(takeover.status).toBe(200);
    } finally {
      await dashboard.stop();
      await coordinator.stop();
    }
  });

  it("restarts a disconnected child and preserves explicit takeover", async () => {
    let attempts = 0;
    const stopped: number[] = [];
    const coordinator = new GridCoordinator([device("a")], 1, async (value) => {
      const generation = ++attempts;
      return {
        session: { ...session(value), token: `secret-${generation}` },
        healthy: async () => generation > 1,
        stop: async () => {
          stopped.push(generation);
        },
      };
    });
    await coordinator.start();
    coordinator.takeOver("a");
    const recovered = await coordinator.reconcile(1_000);
    expect(attempts).toBe(2);
    expect(stopped).toEqual([1]);
    expect(recovered.activeSerial).toBe("a");
    expect(recovered.sessions).toHaveLength(1);
    expect(recovered.failures).toEqual([]);
    await coordinator.stop();
  });

  it("backs off failed reconnects and later recovers", async () => {
    let attempts = 0;
    const coordinator = new GridCoordinator([device("a")], 1, async (value) => {
      const generation = ++attempts;
      if (generation === 2) throw new Error("device unavailable");
      return {
        session: session(value),
        healthy: async () => generation > 1,
        stop: async () => undefined,
      };
    });
    await coordinator.start();
    const failed = await coordinator.reconcile(1_000);
    expect(failed.sessions).toEqual([]);
    expect(failed.failures[0]?.message).toBe("Reconnect failed: device session unavailable.");
    await coordinator.reconcile(5_999);
    expect(attempts).toBe(2);
    const recovered = await coordinator.reconcile(6_000);
    expect(attempts).toBe(3);
    expect(recovered.sessions).toHaveLength(1);
    expect(recovered.failures).toEqual([]);
    await coordinator.stop();
  });
});

async function never(): Promise<never> {
  throw new Error("not called");
}
