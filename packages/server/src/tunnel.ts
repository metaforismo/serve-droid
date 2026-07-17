import { spawn, type ChildProcess } from "node:child_process";
import { access, constants, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { ServeDroidError, type SessionInfo } from "@serve-droid/core";

export const MAX_TUNNEL_DURATION_MS = 2 * 60 * 60 * 1000;

export interface TunnelStatus {
  active: boolean;
  provider: "cloudflare" | null;
  publicUrl: string | null;
  expiresAt: string | null;
}

export interface NamedTunnelOptions {
  executable: string;
  tunnel: string;
  credentialsFile: string;
  publicUrl: string;
  durationMs: number;
  session: SessionInfo;
}

type SpawnTunnel = (executable: string, args: string[]) => ChildProcess;
type Fetcher = typeof fetch;

function validatedPublicOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new ServeDroidError(
      "INVALID_ARGUMENT",
      "--public-url must be an HTTPS origin without credentials, path, query, or fragment.",
    );
  }
  return url;
}

const MAX_CREDENTIALS_BYTES = 64 * 1024;

function config(options: NamedTunnelOptions, publicOrigin: URL, credentialsFile: string): string {
  return [
    `tunnel: ${JSON.stringify(options.tunnel)}`,
    `credentials-file: ${JSON.stringify(credentialsFile)}`,
    "ingress:",
    `  - hostname: ${JSON.stringify(publicOrigin.hostname)}`,
    `    service: ${JSON.stringify(`http://127.0.0.1:${options.session.port}`)}`,
    "  - service: http_status:404",
    "",
  ].join("\n");
}

export async function resolveCloudflaredPath(
  requested?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const executable = platform() === "win32" ? "cloudflared.exe" : "cloudflared";
  const candidates = [
    requested,
    env.CLOUDFLARED_PATH,
    ...(env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => join(entry, executable)),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const path = isAbsolute(candidate) ? candidate : resolve(candidate);
    try {
      await access(path, platform() === "win32" ? constants.F_OK : constants.X_OK);
      return path;
    } catch {
      // Try the next explicit or PATH candidate.
    }
  }
  throw new ServeDroidError(
    "CLOUDFLARED_NOT_FOUND",
    "cloudflared was not found. Install it from the official Cloudflare package, then pass --cloudflared or set CLOUDFLARED_PATH.",
  );
}

export class NamedCloudflareTunnel extends EventEmitter<{ close: [TunnelStatus] }> {
  readonly #publicOrigin: URL;
  readonly #spawn: SpawnTunnel;
  readonly #fetch: Fetcher;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #readinessAttempts: number;
  #child: ChildProcess | undefined;
  #directory = "";
  #timer: NodeJS.Timeout | undefined;
  #expiresAt: string | null = null;
  #processExited = false;
  #stopping = false;

  public constructor(
    private readonly options: NamedTunnelOptions,
    dependencies: {
      spawn?: SpawnTunnel;
      fetch?: Fetcher;
      sleep?: (milliseconds: number) => Promise<void>;
      readinessAttempts?: number;
    } = {},
  ) {
    super();
    this.#publicOrigin = validatedPublicOrigin(options.publicUrl);
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(options.tunnel)) {
      throw new ServeDroidError("INVALID_ARGUMENT", "Tunnel name contains unsupported characters.");
    }
    if (
      !Number.isInteger(options.durationMs) ||
      options.durationMs < 60_000 ||
      options.durationMs > MAX_TUNNEL_DURATION_MS
    ) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "Tunnel duration must be between 1 and 120 minutes.",
      );
    }
    this.#spawn =
      dependencies.spawn ??
      ((executable, args) =>
        spawn(executable, args, { stdio: "ignore", windowsHide: true, shell: false }));
    this.#fetch = dependencies.fetch ?? fetch;
    this.#sleep =
      dependencies.sleep ??
      ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
    this.#readinessAttempts = dependencies.readinessAttempts ?? 40;
  }

  public get status(): TunnelStatus {
    return {
      active: Boolean(this.#child),
      provider: this.#child ? "cloudflare" : null,
      publicUrl: this.#child ? this.#publicOrigin.origin : null,
      expiresAt: this.#expiresAt,
    };
  }

  public async start(): Promise<TunnelStatus> {
    if (this.#child) return this.status;
    const credentialsPath = resolve(this.options.credentialsFile);
    let credentialsContents: Buffer;
    try {
      const credentialsHandle = await open(
        credentialsPath,
        constants.O_RDONLY | (platform() === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      try {
        const credentials = await credentialsHandle.stat();
        if (!credentials.isFile())
          throw new ServeDroidError(
            "INVALID_ARGUMENT",
            "Tunnel credentials path must be a regular file, not a symbolic link.",
          );
        if (credentials.size > MAX_CREDENTIALS_BYTES)
          throw new ServeDroidError(
            "INVALID_ARGUMENT",
            "Tunnel credentials file exceeds the 64 KiB limit.",
          );
        if (platform() !== "win32" && (credentials.mode & 0o077) !== 0)
          throw new ServeDroidError(
            "INVALID_ARGUMENT",
            "Tunnel credentials must not be accessible by group or other users (use chmod 600).",
          );
        credentialsContents = await credentialsHandle.readFile();
      } finally {
        await credentialsHandle.close();
      }
      const parsed = JSON.parse(credentialsContents.toString("utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    } catch (error) {
      if (error instanceof ServeDroidError) throw error;
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "Tunnel credentials must be a readable, private JSON file without symbolic links.",
      );
    }
    this.#directory = await mkdtemp(join(tmpdir(), "serve-droid-tunnel-"));
    const privateCredentialsPath = join(this.#directory, "credentials.json");
    await writeFile(privateCredentialsPath, credentialsContents, { mode: 0o600, flag: "wx" });
    const configPath = join(this.#directory, "config.yml");
    await writeFile(configPath, config(this.options, this.#publicOrigin, privateCredentialsPath), {
      mode: 0o600,
      flag: "wx",
    });
    const child = this.#spawn(this.options.executable, [
      "tunnel",
      "--config",
      configPath,
      "--no-autoupdate",
      "run",
      this.options.tunnel,
    ]);
    this.#child = child;
    this.#processExited = false;
    child.once("exit", () => {
      this.#processExited = true;
      if (this.#expiresAt) void this.stop();
    });
    try {
      await new Promise<void>((resolvePromise, reject) => {
        child.once("spawn", resolvePromise);
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`cloudflared exited before readiness (${code ?? "signal"}).`)),
        );
      });
      await this.#waitUntilReachable();
      this.#expiresAt = new Date(Date.now() + this.options.durationMs).toISOString();
      await this.#notify(true);
      this.#timer = setTimeout(() => void this.stop(), this.options.durationMs);
      this.#timer.unref();
      return this.status;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#child?.kill("SIGTERM");
    this.#child = undefined;
    await this.#notify(false).catch(() => undefined);
    if (this.#directory) await rm(this.#directory, { recursive: true, force: true });
    this.#directory = "";
    this.#expiresAt = null;
    this.#stopping = false;
    this.emit("close", this.status);
  }

  async #waitUntilReachable(): Promise<void> {
    for (let attempt = 0; attempt < this.#readinessAttempts; attempt += 1) {
      if (!this.#child || this.#processExited)
        throw new ServeDroidError("TRANSPORT_FAILED", "Tunnel process stopped.");
      try {
        const response = await this.#fetch(`${this.#publicOrigin.origin}/api/v1/health`, {
          signal: AbortSignal.timeout(2_000),
          redirect: "error",
        });
        if (response.ok) return;
      } catch {
        // DNS and edge routing can take a short time after the connector starts.
      }
      await this.#sleep(500);
    }
    throw new ServeDroidError(
      "TRANSPORT_FAILED",
      "The public tunnel did not reach serve-droid health within 20 seconds.",
    );
  }

  async #notify(active: boolean): Promise<void> {
    const response = await this.#fetch(`${this.options.session.url}/api/v1/remote-access`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        active,
        provider: active ? "cloudflare" : null,
        publicUrl: active ? this.#publicOrigin.origin : null,
        expiresAt: active ? this.#expiresAt : null,
      }),
    });
    if (!response.ok)
      throw new ServeDroidError("TRANSPORT_FAILED", "Session rejected remote-access state.");
  }
}
