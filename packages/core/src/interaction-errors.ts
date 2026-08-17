import type { AdbRunner, RunResult } from "./adb.js";
import { ServeDroidError } from "./errors.js";

const MAX_DIAGNOSTIC_OUTPUT = 256 * 1024;
const MAX_ANDROID_MESSAGE = 512;
const MAX_CLASSIFICATION_INPUT = 4 * 1024;
const KEYGUARD_DIAGNOSTIC_TIMEOUT_MS = 3_000;
const MAX_EVIDENCE = 12;

export type InteractionOperation =
  "tap" | "swipe" | "gesture" | "type" | "key" | "ui-hierarchy" | "screenshot";

export interface KeyguardDiagnostics {
  showing: boolean | null;
  secure: boolean | null;
  inputRestricted: boolean | null;
  aodShowing: boolean | null;
  locked: boolean | null;
  evidence: string[];
}

export interface InteractionCommandOptions {
  serial: string;
  operation: InteractionOperation;
  timeoutMs?: number;
}

type KeyguardBlock = "delegate" | "monitor" | "controller";
type BooleanFields = Partial<Record<string, boolean>>;

const ALLOWED_FIELDS: Record<KeyguardBlock, ReadonlySet<string>> = {
  delegate: new Set([
    "showing",
    "showingAndNotOccluded",
    "inputRestricted",
    "secure",
    "mKeyguardSecure",
  ]),
  monitor: new Set(["mIsShowing", "mInputRestricted", "mSimSecure"]),
  controller: new Set(["mKeyguardShowing", "mKeyguardGoingAway", "mOccluded", "mAodShowing"]),
};

function headerBlock(value: string): KeyguardBlock | null {
  if (value.includes("=")) return null;
  if (/(?:^|[.$\s])KeyguardServiceDelegate:?$/u.test(value)) return "delegate";
  if (/(?:^|[.$\s])KeyguardStateMonitor:?$/u.test(value)) return "monitor";
  if (/(?:^|[.$\s])KeyguardController:?$/u.test(value)) return "controller";
  return null;
}

function indentation(value: string): number {
  return value.length - value.trimStart().length;
}

function knownBoolean(values: Array<boolean | undefined>): boolean | null {
  if (values.includes(true)) return true;
  const known = values.filter((value): value is boolean => value !== undefined);
  return known.length > 0 && known.every((value) => value === false) ? false : null;
}

function evidenceEntry(block: KeyguardBlock, field: string, value: boolean): string {
  const prefix =
    block === "delegate"
      ? "KeyguardServiceDelegate"
      : block === "monitor"
        ? "KeyguardStateMonitor"
        : "KeyguardController";
  return `${prefix}.${field}=${String(value)}`;
}

export function parseKeyguardDiagnostics(output: string): KeyguardDiagnostics {
  const fields: Record<KeyguardBlock, BooleanFields> = {
    delegate: {},
    monitor: {},
    controller: {},
  };
  const evidence: string[] = [];
  let block: KeyguardBlock | null = null;
  let headerIndent = -1;

  for (const line of output.slice(0, MAX_DIAGNOSTIC_OUTPUT).split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const nextBlock = headerBlock(trimmed);
    if (nextBlock) {
      block = nextBlock;
      headerIndent = indentation(line);
      continue;
    }
    if (!block) continue;

    const assignment = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(true|false)\b/u.exec(trimmed);
    if (assignment && ALLOWED_FIELDS[block].has(assignment[1]!)) {
      const field = assignment[1]!;
      const value = assignment[2] === "true";
      fields[block][field] = value;
      if (evidence.length < MAX_EVIDENCE) evidence.push(evidenceEntry(block, field, value));
      continue;
    }
    if (indentation(line) <= headerIndent) {
      block = null;
      headerIndent = -1;
    }
  }

  const delegateShowing = knownBoolean([
    fields.delegate.showing,
    fields.delegate.showingAndNotOccluded,
  ]);
  const monitorShowing = fields.monitor.mIsShowing;
  const controllerShowing = fields.controller.mKeyguardShowing;
  const goingAway = fields.controller.mKeyguardGoingAway;
  const aodShowing = fields.controller.mAodShowing ?? null;
  const controllerLocked =
    controllerShowing === true
      ? goingAway === true
        ? false
        : true
      : controllerShowing === false
        ? false
        : null;
  const showing = knownBoolean([
    delegateShowing ?? undefined,
    monitorShowing,
    controllerLocked ?? undefined,
  ]);
  const inputRestricted = knownBoolean([
    fields.delegate.inputRestricted,
    fields.monitor.mInputRestricted,
  ]);
  const delegateSecure = knownBoolean([fields.delegate.secure, fields.delegate.mKeyguardSecure]);
  const secure =
    delegateSecure !== null ? delegateSecure : fields.monitor.mSimSecure === true ? true : null;
  const locked =
    inputRestricted === true || showing === true || aodShowing === true
      ? true
      : showing === false
        ? false
        : null;

  return {
    showing,
    secure,
    inputRestricted,
    aodShowing,
    locked,
    evidence,
  };
}

function mergeBoolean(left: boolean | null, right: boolean | null): boolean | null {
  if (left === true || right === true) return true;
  if (left === false && right === false) return false;
  return left ?? right;
}

function mergeKeyguardDiagnostics(
  left: KeyguardDiagnostics,
  right: KeyguardDiagnostics,
): KeyguardDiagnostics {
  return {
    showing: mergeBoolean(left.showing, right.showing),
    secure: mergeBoolean(left.secure, right.secure),
    inputRestricted: mergeBoolean(left.inputRestricted, right.inputRestricted),
    aodShowing: mergeBoolean(left.aodShowing, right.aodShowing),
    locked: mergeBoolean(left.locked, right.locked),
    evidence: [...new Set([...left.evidence, ...right.evidence])].slice(0, MAX_EVIDENCE),
  };
}

function emptyKeyguardDiagnostics(): KeyguardDiagnostics {
  return {
    showing: null,
    secure: null,
    inputRestricted: null,
    aodShowing: null,
    locked: null,
    evidence: [],
  };
}

export async function readKeyguardDiagnostics(
  adb: AdbRunner,
  serial: string,
): Promise<KeyguardDiagnostics> {
  let diagnostics = emptyKeyguardDiagnostics();
  const commands: readonly (readonly string[])[] = [
    ["shell", "dumpsys", "window", "policy"],
    ["shell", "dumpsys", "activity", "activities"],
  ];

  for (const args of commands) {
    try {
      const result = await adb.run(args, {
        serial,
        timeoutMs: KEYGUARD_DIAGNOSTIC_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) continue;
      diagnostics = mergeKeyguardDiagnostics(
        diagnostics,
        parseKeyguardDiagnostics(`${result.stdout}\n${result.stderr}`),
      );
      const conclusive =
        diagnostics.locked === false ||
        (diagnostics.locked === true && diagnostics.secure !== null);
      if (conclusive && diagnostics.evidence.length > 0) break;
    } catch {
      // Diagnostics are best-effort and must never replace the original interaction failure.
    }
  }
  return diagnostics;
}

function boundedMessage(value: string): string {
  const normalized = value
    // eslint-disable-next-line no-control-regex -- Intentionally strips ANSI CSI from untrusted Android output.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    // eslint-disable-next-line no-control-regex -- Intentionally replaces remaining C0 and DEL controls.
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return "Android interaction failed.";
  return normalized.slice(0, MAX_ANDROID_MESSAGE);
}

function failureMessage(value: unknown): string {
  if (typeof value === "string") return boundedMessage(value);
  if (value instanceof ServeDroidError || value instanceof Error)
    return boundedMessage(value.message);
  return boundedMessage(String(value));
}

function resultFailureMessage(result: RunResult): string {
  return boundedMessage(result.stderr || result.stdout || `adb exited ${result.exitCode}`);
}

export function inputRestrictionEvidence(message: string): string | null {
  const normalized = message.slice(0, MAX_CLASSIFICATION_INPUT).toLowerCase().replace(/\s+/gu, " ");

  if (
    /\binject(?:ing)?\b.{0,100}\brequires?\b.{0,100}\binject_events?\b/u.test(normalized) ||
    /\binject_events?\b.{0,100}\bpermission\b/u.test(normalized)
  ) {
    return "inject-events-permission";
  }
  if (
    /\bpermission(?: denial| denied)\b.{0,140}\b(?:inject(?:ing|ion)?|input event)\b/u.test(
      normalized,
    ) ||
    /\b(?:inject(?:ing|ion)?|input event)\b.{0,140}\bpermission(?: denial| denied)\b/u.test(
      normalized,
    )
  ) {
    return "input-injection-permission-denied";
  }
  if (
    /\b(?:input event injection|inject(?:ing)? input events?)\b.{0,140}\b(?:disabled|blocked|not permitted|not allowed|restricted|forbidden)\b/u.test(
      normalized,
    ) ||
    /\b(?:disabled|blocked|not permitted|not allowed|restricted|forbidden)\b.{0,140}\b(?:input event injection|inject(?:ing)? input events?)\b/u.test(
      normalized,
    ) ||
    /\bcannot inject\b.{0,100}\b(?:event|input)\b/u.test(normalized)
  ) {
    return "input-injection-policy";
  }
  return null;
}

export function inputRestrictionError(
  message: string,
  details: Record<string, unknown> = {},
): ServeDroidError | null {
  const evidence = inputRestrictionEvidence(message);
  if (!evidence) return null;
  return new ServeDroidError(
    "INPUT_RESTRICTED",
    "Android or the device policy rejected input injection. Use an unrestricted test device or enable the OEM setting that permits USB-debugging input.",
    {
      ...details,
      evidence,
      retryAfterUnlock: false,
    },
  );
}

export async function diagnoseInteractionError(
  adb: AdbRunner,
  serial: string,
  operation: InteractionOperation,
  error: unknown,
): Promise<ServeDroidError> {
  if (error instanceof ServeDroidError && error.code !== "ADB_FAILED") return error;
  const message = failureMessage(error);
  const restricted = inputRestrictionError(message, { operation, serial });
  if (restricted) return restricted;

  const keyguard = await readKeyguardDiagnostics(adb, serial);
  if (keyguard.locked === true && keyguard.secure === true) {
    return new ServeDroidError(
      "SECURE_SCREEN",
      `The ${operation} interaction failed while Android reports a secure lock screen. Unlock the device and retry.`,
      {
        operation,
        serial,
        retryAfterUnlock: true,
        keyguard,
      },
    );
  }
  if (keyguard.locked === true) {
    return new ServeDroidError(
      "DEVICE_LOCKED",
      `The ${operation} interaction failed while Android reports a locked or input-restricted keyguard. Wake and unlock the device, then retry.`,
      {
        operation,
        serial,
        retryAfterUnlock: true,
        keyguard,
      },
    );
  }
  return new ServeDroidError("ADB_FAILED", message, { operation, serial });
}

export async function runInteractionCommand(
  adb: AdbRunner,
  args: readonly string[],
  options: InteractionCommandOptions,
): Promise<string> {
  const runOptions =
    options.timeoutMs === undefined
      ? { serial: options.serial }
      : { serial: options.serial, timeoutMs: options.timeoutMs };
  let result: RunResult;
  try {
    result = await adb.run(args, runOptions);
  } catch (error) {
    throw await diagnoseInteractionError(adb, options.serial, options.operation, error);
  }
  if (result.exitCode === 0) return result.stdout;
  throw await diagnoseInteractionError(
    adb,
    options.serial,
    options.operation,
    resultFailureMessage(result),
  );
}
