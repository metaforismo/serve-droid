import { createServer, type Server } from "node:http";
import { ServeDroidError } from "@serve-droid/core";

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ServeDroidError("INVALID_ARGUMENT", "Port must be an integer between 0 and 65535.");
  }
}

function publicListenError(error: unknown, host: string, port: number): ServeDroidError {
  const code = error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN";
  if (code === "EADDRINUSE" && port !== 0) {
    return new ServeDroidError(
      "PORT_IN_USE",
      `Port ${port} is already in use on ${host}. Choose --port 0 or another port.`,
      { host, port },
    );
  }
  return new ServeDroidError("TRANSPORT_FAILED", `Could not listen on ${host}:${port}.`, {
    host,
    port,
    causeCode: code,
  });
}

export async function listenHttpServer(server: Server, port: number, host: string): Promise<void> {
  validatePort(port);
  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(publicListenError(error, host, port));
    };
    const onListening = () => {
      cleanup();
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      cleanup();
      reject(publicListenError(error, host, port));
    }
  });
}

export async function assertPortAvailable(host: string, port: number): Promise<void> {
  validatePort(port);
  if (port === 0) return;
  const probe = createServer();
  await listenHttpServer(probe, port, host);
  await new Promise<void>((resolvePromise, reject) => {
    probe.close((error) => (error ? reject(error) : resolvePromise()));
  });
}
