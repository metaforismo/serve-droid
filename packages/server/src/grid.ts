import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SCHEMA_VERSION,
  ServeDroidError,
  type DeviceSummary,
  type SessionInfo,
} from "@serve-droid/core";

export const MAX_GRID_DEVICES = 8;

export interface GridChild {
  session: SessionInfo;
  healthy?(): Promise<boolean>;
  stop(): Promise<void>;
}

export interface GridFailure {
  serial: string;
  message: string;
}

export interface GridSnapshot {
  schemaVersion: 1;
  activeSerial: string | null;
  sessions: Array<Omit<SessionInfo, "token">>;
  failures: GridFailure[];
}

type GridChildFactory = (device: DeviceSummary) => Promise<GridChild>;

function withoutToken(session: SessionInfo): Omit<SessionInfo, "token"> {
  const { token, ...safe } = session;
  void token;
  return safe;
}

export class GridCoordinator {
  readonly #children: GridChild[] = [];
  readonly #failures: GridFailure[] = [];
  readonly #retryAfter = new Map<string, number>();
  #activeSerial: string | null = null;
  #reconcileInFlight: Promise<GridSnapshot> | undefined;

  public constructor(
    private readonly devices: DeviceSummary[],
    private readonly maxDevices: number,
    private readonly createChild: GridChildFactory,
  ) {
    if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > MAX_GRID_DEVICES) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        `--max-devices must be between 1 and ${MAX_GRID_DEVICES}.`,
      );
    }
    const serials = new Set(devices.map((device) => device.serial));
    if (serials.size !== devices.length)
      throw new ServeDroidError("INVALID_ARGUMENT", "Grid device selectors must be unique.");
    if (devices.length > maxDevices) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        `${devices.length} devices exceed the explicit grid limit of ${maxDevices}.`,
      );
    }
  }

  public async start(): Promise<GridSnapshot> {
    for (const device of this.devices) {
      if (device.state !== "device") {
        this.#setFailure(device.serial, `Device is ${device.state}.`);
        this.#retryAfter.set(device.serial, Date.now() + 5_000);
        continue;
      }
      try {
        this.#children.push(await this.createChild(device));
      } catch (error) {
        this.#setFailure(device.serial, publicFailureMessage(error, "Device session failed."));
        this.#retryAfter.set(device.serial, Date.now() + 5_000);
      }
    }
    if (!this.#children.length) {
      throw new ServeDroidError("TRANSPORT_FAILED", "No grid device session could be started.", {
        failures: this.#failures,
      });
    }
    this.#activeSerial = this.#children[0]!.session.device.serial;
    return this.snapshot();
  }

  public reconcile(now = Date.now()): Promise<GridSnapshot> {
    if (this.#reconcileInFlight) return this.#reconcileInFlight;
    this.#reconcileInFlight = this.#reconcile(now).finally(() => {
      this.#reconcileInFlight = undefined;
    });
    return this.#reconcileInFlight;
  }

  public takeOver(serial: string): GridSnapshot {
    if (!this.#children.some((child) => child.session.device.serial === serial)) {
      throw new ServeDroidError("DEVICE_NOT_FOUND", `Grid device '${serial}' is not active.`);
    }
    this.#activeSerial = serial;
    return this.snapshot();
  }

  public snapshot(): GridSnapshot {
    return {
      schemaVersion: SCHEMA_VERSION,
      activeSerial: this.#activeSerial,
      sessions: this.#children.map((child) => withoutToken(child.session)),
      failures: [...this.#failures],
    };
  }

  public async stop(): Promise<void> {
    await this.#reconcileInFlight?.catch(() => undefined);
    await Promise.allSettled(this.#children.splice(0).map((child) => child.stop()));
    this.#activeSerial = null;
  }

  async #reconcile(now: number): Promise<GridSnapshot> {
    const health = await Promise.all(
      [...this.#children].map(async (child) => ({
        child,
        healthy: child.healthy ? await child.healthy().catch(() => false) : true,
      })),
    );
    for (const { child, healthy } of health) {
      if (healthy) continue;
      await child.stop().catch(() => undefined);
      this.#children.splice(this.#children.indexOf(child), 1);
      this.#setFailure(child.session.device.serial, "Session disconnected; reconnecting.");
      this.#retryAfter.delete(child.session.device.serial);
    }

    for (const device of this.devices) {
      if (this.#children.some((child) => child.session.device.serial === device.serial)) continue;
      if ((this.#retryAfter.get(device.serial) ?? 0) > now) continue;
      try {
        this.#children.push(await this.createChild(device));
        this.#clearFailure(device.serial);
        this.#retryAfter.delete(device.serial);
      } catch (error) {
        this.#setFailure(
          device.serial,
          `Reconnect failed: ${publicFailureMessage(error, "device session unavailable.")}`,
        );
        this.#retryAfter.set(device.serial, now + 5_000);
      }
    }
    const order = new Map(this.devices.map((device, index) => [device.serial, index]));
    this.#children.sort(
      (left, right) =>
        (order.get(left.session.device.serial) ?? 0) -
        (order.get(right.session.device.serial) ?? 0),
    );
    if (
      !this.#activeSerial ||
      !this.#children.some((child) => child.session.device.serial === this.#activeSerial)
    ) {
      this.#activeSerial = this.#children[0]?.session.device.serial ?? null;
    }
    return this.snapshot();
  }

  #setFailure(serial: string, message: string): void {
    const existing = this.#failures.find((failure) => failure.serial === serial);
    if (existing) existing.message = message;
    else this.#failures.push({ serial, message });
  }

  #clearFailure(serial: string): void {
    const index = this.#failures.findIndex((failure) => failure.serial === serial);
    if (index >= 0) this.#failures.splice(index, 1);
  }
}

function publicFailureMessage(error: unknown, fallback: string): string {
  return error instanceof ServeDroidError ? error.message : fallback;
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += value.length;
    if (size > 16 * 1024)
      throw new ServeDroidError("INVALID_ARGUMENT", "Grid request is too large.");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new ServeDroidError("INVALID_ARGUMENT", "Grid request must be valid JSON.");
  }
}

export class GridDashboard {
  readonly #http;
  readonly #token = randomBytes(32).toString("base64url");
  #url = "";

  public constructor(
    private readonly coordinator: GridCoordinator,
    private readonly port = 0,
  ) {
    this.#http = createServer((request, response) => void this.#handle(request, response));
  }

  public get token(): string {
    return this.#token;
  }

  public async start(): Promise<string> {
    await new Promise<void>((resolvePromise, reject) => {
      this.#http.once("error", reject);
      this.#http.listen(this.port, "127.0.0.1", resolvePromise);
    });
    this.#url = `http://127.0.0.1:${(this.#http.address() as AddressInfo).port}`;
    return this.#url;
  }

  public async stop(): Promise<void> {
    await new Promise<void>((resolvePromise) => this.#http.close(() => resolvePromise()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; frame-src http://127.0.0.1:*; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    );
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/" && request.method === "GET") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(this.#html());
      return;
    }
    const authorization = request.headers.authorization ?? "";
    if (!authorization.startsWith("Bearer ") || !safeEqual(authorization.slice(7), this.#token)) {
      sendJson(response, 401, {
        schemaVersion: SCHEMA_VERSION,
        error: { code: "AUTHENTICATION_REQUIRED", message: "A valid grid token is required." },
      });
      return;
    }
    try {
      if (url.pathname === "/api/v1/grid" && request.method === "GET") {
        sendJson(response, 200, await this.coordinator.reconcile());
      } else if (url.pathname === "/api/v1/takeover" && request.method === "POST") {
        const value = await body(request);
        const serial = typeof value.serial === "string" ? value.serial : "";
        sendJson(response, 200, this.coordinator.takeOver(serial));
      } else {
        sendJson(response, 404, {
          schemaVersion: SCHEMA_VERSION,
          error: { code: "NOT_FOUND", message: "Grid route not found." },
        });
      }
    } catch (error) {
      if (error instanceof ServeDroidError) {
        sendJson(response, 400, {
          schemaVersion: SCHEMA_VERSION,
          error: { code: error.code, message: error.message },
        });
      } else {
        sendJson(response, 500, {
          schemaVersion: SCHEMA_VERSION,
          error: {
            code: "INTERNAL_ERROR",
            message: "The grid request could not be completed.",
          },
        });
      }
    }
  }

  #html(): string {
    const bootstrap = JSON.stringify({ token: this.#token }).replaceAll("<", "\\u003c");
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>serve-droid grid</title><style>body{margin:0;background:#0b0c0f;color:#f7f7f8;font:14px system-ui}header{padding:16px 20px;border-bottom:1px solid #292c33}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;padding:12px}.card{border:1px solid #292c33;border-radius:12px;overflow:hidden;background:#15171c}.card.active{border-color:#6ee7b7}.meta{display:flex;justify-content:space-between;align-items:center;padding:10px}iframe{display:block;width:100%;height:640px;border:0;background:#000}button{background:#252932;color:inherit;border:1px solid #3a404d;border-radius:7px;padding:7px 10px}</style><header><strong>serve-droid grid</strong> · bounded local multi-device view</header><main id="grid"></main><script>const boot=${bootstrap};async function api(path,init={}){const response=await fetch(path,{...init,headers:{authorization:'Bearer '+boot.token,'content-type':'application/json',...(init.headers||{})}});return response.json()}async function render(){const state=await api('/api/v1/grid');const root=document.querySelector('#grid');root.replaceChildren();for(const session of state.sessions){const card=document.createElement('section');card.className='card '+(state.activeSerial===session.device.serial?'active':'');const meta=document.createElement('div');meta.className='meta';const label=document.createElement('span');label.textContent=session.device.serial;const button=document.createElement('button');button.textContent='Take control';button.onclick=async()=>{await api('/api/v1/takeover',{method:'POST',body:JSON.stringify({serial:session.device.serial})});render()};const frame=document.createElement('iframe');frame.title=session.device.serial+' Android cockpit';frame.src=session.url;meta.append(label,button);card.append(meta,frame);root.append(card)}}render()</script></html>`;
  }
}
