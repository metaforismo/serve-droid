export type ErrorCode =
  | "ADB_NOT_FOUND"
  | "ADB_FAILED"
  | "CLOUDFLARED_NOT_FOUND"
  | "EMULATOR_NOT_FOUND"
  | "EMULATOR_FAILED"
  | "AVD_NOT_FOUND"
  | "AVD_IMAGE_MISSING"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_AMBIGUOUS"
  | "DEVICE_UNAUTHORIZED"
  | "DEVICE_OFFLINE"
  | "UNSUPPORTED_ANDROID"
  | "INVALID_ARGUMENT"
  | "ELEMENT_NOT_FOUND"
  | "ELEMENT_AMBIGUOUS"
  | "PACKAGE_NOT_FOUND"
  | "AUTHENTICATION_REQUIRED"
  | "SESSION_NOT_FOUND"
  | "PORT_IN_USE"
  | "TRANSPORT_FAILED";

export class ServeDroidError extends Error {
  public readonly code: ErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ServeDroidError";
    this.code = code;
    this.details = details;
  }
}

export function errorExitCode(error: unknown): number {
  if (!(error instanceof ServeDroidError)) return 1;
  if (error.code === "ADB_NOT_FOUND" || error.code === "CLOUDFLARED_NOT_FOUND") return 10;
  if (error.code.startsWith("EMULATOR_") || error.code.startsWith("AVD_")) return 11;
  if (error.code.startsWith("DEVICE_") || error.code === "UNSUPPORTED_ANDROID") return 20;
  if (error.code === "INVALID_ARGUMENT") return 30;
  if (error.code === "PORT_IN_USE") return 31;
  if (error.code === "AUTHENTICATION_REQUIRED") return 40;
  if (error.code === "SESSION_NOT_FOUND") return 50;
  return 1;
}
