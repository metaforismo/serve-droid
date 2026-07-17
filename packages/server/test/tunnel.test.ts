import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type DeviceSummary, type SessionInfo } from "@serve-droid/core";
import { NamedCloudflareTunnel } from "../src/tunnel.js";

class FakeTunnelProcess extends EventEmitter {
  public killed = false;
  public kill(): boolean {
    this.killed = true;
    this.emit("exit", 0);
    return true;
  }
}

const device: DeviceSummary = {
  serial: "serial",
  state: "device",
  kind: "physical",
  model: "Pixel",
  product: null,
  manufacturer: "Google",
  apiLevel: 35,
  abi: "arm64-v8a",
};

const session: SessionInfo = {
  schemaVersion: SCHEMA_VERSION,
  device,
  display: { width: 1080, height: 1920, density: 420, orientation: "portrait" },
  pid: 10,
  host: "127.0.0.1",
  port: 8123,
  url: "http://127.0.0.1:8123",
  token: "session-secret",
  startedAt: "2026-07-17T00:00:00.000Z",
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("named Cloudflare tunnel", () => {
  it("verifies public health, reports visible state, expires, and removes private config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "serve-droid-tunnel-test-"));
    directories.push(directory);
    const credentialsFile = join(directory, "credentials.json");
    await writeFile(credentialsFile, '{"TunnelID":"test"}', { mode: 0o600 });
    const process = new FakeTunnelProcess();
    let configPath = "";
    const notifications: Array<Record<string, unknown>> = [];
    const manager = new NamedCloudflareTunnel(
      {
        executable: "/opt/cloudflared",
        tunnel: "serve-droid-test",
        credentialsFile,
        publicUrl: "https://android.example.test",
        durationMs: 60_000,
        session,
      },
      {
        spawn: (_executable, args) => {
          configPath = args[2]!;
          queueMicrotask(() => process.emit("spawn"));
          return process as never;
        },
        fetch: (async (input, init) => {
          const url = String(input);
          if (url.startsWith(session.url)) {
            notifications.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          }
          return new Response(null, { status: 200 });
        }) as typeof fetch,
      },
    );

    const status = await manager.start();
    expect(status).toMatchObject({
      active: true,
      provider: "cloudflare",
      publicUrl: "https://android.example.test",
    });
    expect(notifications[0]).toMatchObject({ active: true, provider: "cloudflare" });
    if (platform() !== "win32") expect((await stat(configPath)).mode & 0o077).toBe(0);
    const closed = once(manager, "close");
    process.emit("exit", 1);
    await closed;
    expect(manager.status.active).toBe(false);
    expect(process.killed).toBe(true);
    expect(notifications.at(-1)).toEqual({
      active: false,
      provider: null,
      publicUrl: null,
      expiresAt: null,
    });
    await expect(stat(configPath)).rejects.toThrow();
  });

  it("rejects non-HTTPS origins and unbounded lifetimes before spawning", () => {
    expect(
      () =>
        new NamedCloudflareTunnel({
          executable: "cloudflared",
          tunnel: "test",
          credentialsFile: "/credentials",
          publicUrl: "http://example.test/path?token=bad",
          durationMs: 60_000,
          session,
        }),
    ).toThrow(/HTTPS origin/u);
    expect(
      () =>
        new NamedCloudflareTunnel({
          executable: "cloudflared",
          tunnel: "test",
          credentialsFile: "/credentials",
          publicUrl: "https://example.test",
          durationMs: 24 * 60 * 60 * 1000,
          session,
        }),
    ).toThrow(/120 minutes/u);
  });

  it("rejects redirected public readiness on a hostile network and cleans up", async () => {
    const directory = await mkdtemp(join(tmpdir(), "serve-droid-tunnel-hostile-test-"));
    directories.push(directory);
    const credentialsFile = join(directory, "credentials.json");
    await writeFile(credentialsFile, '{"TunnelID":"test"}', { mode: 0o600 });
    const process = new FakeTunnelProcess();
    const manager = new NamedCloudflareTunnel(
      {
        executable: "/opt/cloudflared",
        tunnel: "serve-droid-test",
        credentialsFile,
        publicUrl: "https://android.example.test",
        durationMs: 60_000,
        session,
      },
      {
        spawn: () => {
          queueMicrotask(() => process.emit("spawn"));
          return process as never;
        },
        fetch: (async (input) =>
          String(input).startsWith(session.url)
            ? new Response(null, { status: 200 })
            : new Response(null, {
                status: 302,
                headers: { location: "https://attacker.test" },
              })) as typeof fetch,
        sleep: async () => undefined,
        readinessAttempts: 1,
      },
    );
    await expect(manager.start()).rejects.toThrow(/did not reach/u);
    expect(process.killed).toBe(true);
    expect(manager.status.active).toBe(false);
  });

  it("recovers from transient public readiness failures without restarting the connector", async () => {
    const directory = await mkdtemp(join(tmpdir(), "serve-droid-tunnel-retry-test-"));
    directories.push(directory);
    const credentialsFile = join(directory, "credentials.json");
    await writeFile(credentialsFile, '{"TunnelID":"test"}', { mode: 0o600 });
    const process = new FakeTunnelProcess();
    let spawns = 0;
    let publicAttempts = 0;
    const manager = new NamedCloudflareTunnel(
      {
        executable: "/opt/cloudflared",
        tunnel: "serve-droid-test",
        credentialsFile,
        publicUrl: "https://android.example.test",
        durationMs: 60_000,
        session,
      },
      {
        spawn: () => {
          spawns += 1;
          queueMicrotask(() => process.emit("spawn"));
          return process as never;
        },
        fetch: (async (input) => {
          if (String(input).startsWith(session.url)) return new Response(null, { status: 200 });
          publicAttempts += 1;
          if (publicAttempts === 1) throw new TypeError("temporary network failure");
          return new Response(null, { status: 200 });
        }) as typeof fetch,
        sleep: async () => undefined,
        readinessAttempts: 2,
      },
    );
    await expect(manager.start()).resolves.toMatchObject({ active: true });
    expect(publicAttempts).toBe(2);
    expect(spawns).toBe(1);
    await manager.stop();
    expect(process.killed).toBe(true);
  });
});
