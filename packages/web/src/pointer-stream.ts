export interface PointerPoint {
  x: number;
  y: number;
}

interface ControlErrorBody {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

interface ControlResponse {
  ok?: boolean;
  error?: ControlErrorBody;
}

interface PendingResponse {
  resolve: () => void;
  reject: (error: PointerStreamError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PointerStreamClientOptions {
  createSocket: () => WebSocket;
  onReadyChange?: (ready: boolean) => void;
  onError?: (error: PointerStreamError) => void;
  requestTimeoutMs?: number;
}

const SOCKET_OPEN = 1;
const REQUEST_TIMEOUT_MS = 2_500;
const MIN_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 4_000;
const LIVE_POINTER_HEARTBEAT_MS = 750;

export class PointerStreamError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PointerStreamError";
  }
}

function streamId(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function safeToFallback(error: unknown): boolean {
  return error instanceof PointerStreamError && error.details?.safeToFallback === true;
}

export class PointerStreamClient {
  #socket: WebSocket | undefined;
  #closed = false;
  #ready = false;
  #reconnectDelay = MIN_RECONNECT_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #pending: PendingResponse | undefined;
  #tail: Promise<void> = Promise.resolve();
  #activeId: string | undefined;
  #acceptMoves = false;
  #latestMove: PointerPoint | undefined;
  #currentPoint: PointerPoint | undefined;
  #heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  #moveLoop: Promise<void> | undefined;
  #activeFailure: PointerStreamError | undefined;
  readonly #requestTimeoutMs: number;

  public constructor(private readonly options: PointerStreamClientOptions) {
    this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  public get ready(): boolean {
    return this.#ready;
  }

  public start(): void {
    this.#connect();
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#setReady(false);
    this.#rejectPending(
      new PointerStreamError("TRANSPORT_FAILED", "Live pointer control was closed."),
    );
    this.#socket?.close(1000, "client closed");
    this.#socket = undefined;
    this.#clearActive();
  }

  public async begin(point: PointerPoint): Promise<boolean> {
    if (!this.#ready || this.#socket?.readyState !== SOCKET_OPEN) return false;
    if (this.#activeId) {
      throw new PointerStreamError(
        "TRANSPORT_FAILED",
        "A live browser pointer stream is already active.",
      );
    }
    const id = streamId();
    try {
      await this.#request(this.#message(id, "begin", point));
    } catch (error) {
      if (safeToFallback(error)) return false;
      throw error;
    }
    this.#activeId = id;
    this.#acceptMoves = true;
    this.#currentPoint = point;
    this.#activeFailure = undefined;
    this.#scheduleHeartbeat();
    return true;
  }

  public move(point: PointerPoint): void {
    if (!this.#activeId || !this.#acceptMoves) return;
    this.#currentPoint = point;
    this.#latestMove = point;
    this.#startMoveLoop();
  }

  public async end(point: PointerPoint): Promise<void> {
    const id = this.#activeId;
    if (!id) throw this.#consumeFailureOrInactive();
    this.#acceptMoves = false;
    this.#stopHeartbeat();
    if (this.#moveLoop) await this.#moveLoop;
    if (this.#activeFailure) throw this.#consumeFailureOrInactive();
    if (this.#activeId !== id) throw this.#consumeFailureOrInactive();
    try {
      await this.#request(this.#message(id, "end", point));
    } finally {
      this.#clearActive();
    }
  }

  public async cancel(point: PointerPoint): Promise<void> {
    const id = this.#activeId;
    if (!id) {
      this.#activeFailure = undefined;
      return;
    }
    this.#acceptMoves = false;
    this.#stopHeartbeat();
    this.#latestMove = undefined;
    if (this.#moveLoop) await this.#moveLoop;
    if (this.#activeFailure) {
      this.#clearActive();
      return;
    }
    try {
      await this.#request(this.#message(id, "cancel", point));
    } finally {
      this.#clearActive();
    }
  }

  #startMoveLoop(): void {
    if (this.#moveLoop || !this.#activeId || !this.#acceptMoves || !this.#latestMove) return;
    const loop = this.#flushMoves().catch((error: unknown) => {
      const failure = this.#asError(error);
      this.#activeFailure = failure;
      this.#activeId = undefined;
      this.#acceptMoves = false;
      this.#stopHeartbeat();
      this.options.onError?.(failure);
    });
    this.#moveLoop = loop.finally(() => {
      this.#moveLoop = undefined;
      if (this.#activeId && this.#acceptMoves && this.#latestMove) this.#startMoveLoop();
    });
  }

  async #flushMoves(): Promise<void> {
    while (this.#activeId && this.#acceptMoves && this.#latestMove) {
      const id = this.#activeId;
      const point = this.#latestMove;
      this.#latestMove = undefined;
      await this.#request(this.#message(id, "move", point));
    }
  }

  #message(
    id: string,
    phase: "begin" | "move" | "end" | "cancel",
    point: PointerPoint,
  ): Record<string, unknown> {
    return {
      type: "gesture",
      gesture: {
        points: [point],
        stream: { id, phase },
      },
    };
  }

  #scheduleHeartbeat(): void {
    this.#stopHeartbeat();
    if (!this.#activeId || !this.#acceptMoves) return;
    this.#heartbeatTimer = setTimeout(() => {
      this.#heartbeatTimer = undefined;
      if (!this.#activeId || !this.#acceptMoves || !this.#currentPoint) return;
      this.move(this.#currentPoint);
      this.#scheduleHeartbeat();
    }, LIVE_POINTER_HEARTBEAT_MS);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #connect(): void {
    if (this.#closed || this.#socket) return;
    let socket: WebSocket;
    try {
      socket = this.options.createSocket();
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#socket !== socket || this.#closed) return;
      this.#reconnectDelay = MIN_RECONNECT_MS;
      this.#setReady(true);
    };
    socket.onmessage = (event) => this.#receive(event.data);
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#setReady(false);
      const failure = new PointerStreamError(
        "TRANSPORT_FAILED",
        "Live pointer control connection closed.",
      );
      this.#rejectPending(failure);
      if (this.#activeId) {
        this.#activeFailure = failure;
        this.#activeId = undefined;
        this.#acceptMoves = false;
        this.#stopHeartbeat();
        this.#latestMove = undefined;
        this.options.onError?.(failure);
      }
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer) return;
    const delay = this.#reconnectDelay;
    this.#reconnectDelay = Math.min(MAX_RECONNECT_MS, this.#reconnectDelay * 2);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delay);
  }

  #setReady(ready: boolean): void {
    if (this.#ready === ready) return;
    this.#ready = ready;
    this.options.onReadyChange?.(ready);
  }

  #request(body: Record<string, unknown>): Promise<void> {
    return this.#enqueue(
      () =>
        new Promise<void>((resolve, reject) => {
          const socket = this.#socket;
          if (!socket || socket.readyState !== SOCKET_OPEN) {
            reject(
              new PointerStreamError("TRANSPORT_FAILED", "Live pointer control is not connected."),
            );
            return;
          }
          if (this.#pending) {
            reject(
              new PointerStreamError(
                "TRANSPORT_FAILED",
                "Live pointer control response ordering was violated.",
              ),
            );
            return;
          }
          const timer = setTimeout(() => {
            if (this.#pending?.timer !== timer) return;
            this.#pending = undefined;
            const failure = new PointerStreamError(
              "TRANSPORT_FAILED",
              "Live pointer control timed out.",
            );
            reject(failure);
            socket.close(1011, "control timeout");
          }, this.#requestTimeoutMs);
          this.#pending = { resolve, reject, timer };
          try {
            socket.send(JSON.stringify(body));
          } catch (error) {
            clearTimeout(timer);
            this.#pending = undefined;
            reject(this.#asError(error));
          }
        }),
    );
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  #receive(raw: unknown): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    let response: ControlResponse;
    try {
      response = JSON.parse(String(raw)) as ControlResponse;
    } catch {
      pending.reject(
        new PointerStreamError("TRANSPORT_FAILED", "Live pointer control returned invalid JSON."),
      );
      return;
    }
    if (response.error) {
      pending.reject(
        new PointerStreamError(
          response.error.code ?? "TRANSPORT_FAILED",
          response.error.message ?? "Live pointer control failed.",
          response.error.details,
        ),
      );
      return;
    }
    pending.resolve();
  }

  #rejectPending(error: PointerStreamError): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #consumeFailureOrInactive(): PointerStreamError {
    const failure =
      this.#activeFailure ??
      new PointerStreamError("TRANSPORT_FAILED", "No live browser pointer stream is active.");
    this.#activeFailure = undefined;
    return failure;
  }

  #clearActive(): void {
    this.#stopHeartbeat();
    this.#activeId = undefined;
    this.#acceptMoves = false;
    this.#latestMove = undefined;
    this.#currentPoint = undefined;
    this.#activeFailure = undefined;
  }

  #asError(error: unknown): PointerStreamError {
    return error instanceof PointerStreamError
      ? error
      : new PointerStreamError(
          "TRANSPORT_FAILED",
          error instanceof Error ? error.message : String(error),
        );
  }
}
