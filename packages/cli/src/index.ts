#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  AdbClient,
  AndroidService,
  EmulatorClient,
  SCHEMA_VERSION,
  ServeDroidError,
  errorExitCode,
  listDevices,
  listAvds,
  resolveAdbPath,
  resolveEmulatorPath,
  selectDevice,
  startAvd,
} from "@serve-droid/core";
import {
  NamedCloudflareTunnel,
  readSessionStates,
  recoverPartialRecordings,
  removeRecording,
  removeSessionState,
  ServeDroidServer,
  resolveCloudflaredPath,
} from "@serve-droid/server";
import { runMcpServer } from "@serve-droid/mcp";

interface GlobalOptions {
  device?: string;
  json?: boolean;
  quiet?: boolean;
}

function output(value: unknown, options: GlobalOptions, human?: string): void {
  if (options.quiet) return;
  if (options.json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stdout.write(`${human ?? JSON.stringify(value, null, 2)}\n`);
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

async function client(): Promise<AdbClient> {
  return new AdbClient(await resolveAdbPath());
}

async function service(options: GlobalOptions): Promise<AndroidService> {
  return AndroidService.connect(await client(), options.device);
}

async function emulator(): Promise<EmulatorClient> {
  return new EmulatorClient(await resolveEmulatorPath());
}

function addGlobal(command: Command): Command {
  return command
    .option("-d, --device <serial-or-name>", "target ADB device")
    .option("--json", "emit stable machine-readable JSON")
    .option("-q, --quiet", "suppress normal output");
}

const program = addGlobal(new Command())
  .name("serve-droid")
  .description("Stream, inspect, and control Android devices from browsers and AI agents.")
  .version("0.1.0")
  .showSuggestionAfterError();

program
  .command("doctor")
  .description("Check Node, ADB, devices, authorization, and Android API support.")
  .action(async (_options, command) => {
    const options = globalOptions(command);
    const checks: Array<{ name: string; ok: boolean; message: string }> = [];
    checks.push({
      name: "node",
      ok: Number(process.versions.node.split(".")[0]) >= 22,
      message: `Node ${process.versions.node}`,
    });
    try {
      const adbPath = await resolveAdbPath();
      checks.push({ name: "adb", ok: true, message: adbPath });
      const devices = await listDevices(new AdbClient(adbPath));
      checks.push({
        name: "devices",
        ok: devices.some((device) => device.state === "device"),
        message: `${devices.length} detected`,
      });
      for (const device of devices) {
        checks.push({
          name: `device:${device.serial}`,
          ok: device.state === "device" && (device.apiLevel ?? 0) >= 26,
          message: `${device.state}; ${device.model ?? "unknown model"}; API ${device.apiLevel ?? "unknown"}`,
        });
      }
    } catch (error) {
      checks.push({
        name: "adb",
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const ok = checks.every((check) => check.ok);
    output(
      { schemaVersion: SCHEMA_VERSION, ok, checks },
      options,
      checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.name}: ${check.message}`).join("\n"),
    );
    if (!ok) process.exitCode = 10;
  });

program
  .command("devices")
  .description("List Android devices visible to ADB.")
  .action(async (_options, command) => {
    const options = globalOptions(command);
    const devices = await listDevices(await client());
    output(
      { schemaVersion: SCHEMA_VERSION, devices },
      options,
      devices
        .map(
          (device) =>
            `${device.serial}\t${device.state}\t${device.model ?? "unknown"}\tAPI ${device.apiLevel ?? "?"}`,
        )
        .join("\n"),
    );
  });

const avd = program
  .command("avd")
  .description("Discover and explicitly start or stop installed Android Virtual Devices.");

avd
  .command("list")
  .description("List installed AVDs separately from ADB-connected devices.")
  .action(async (_local, command) => {
    const options = globalOptions(command);
    const devices = await listAvds(await emulator());
    output(
      { schemaVersion: SCHEMA_VERSION, avds: devices },
      options,
      devices
        .map(
          (item) =>
            `${item.name}\t${item.target ?? "unknown target"}\t${item.imageAvailable === false ? "missing image" : "ready"}`,
        )
        .join("\n") || "No installed AVDs.",
    );
  });

avd
  .command("start <name>")
  .description("Start an installed AVD without downloading SDK content.")
  .option("--headless", "run without an emulator window")
  .option("--cold-boot", "ignore saved snapshots")
  .option("--wipe-data", "reset the AVD data partition")
  .option("--yes", "confirm destructive data reset")
  .action(async (name, local, command) => {
    const options = globalOptions(command);
    if (local.wipeData && !local.yes) {
      throw new ServeDroidError("INVALID_ARGUMENT", "--wipe-data requires --yes.");
    }
    const started = await startAvd(await emulator(), name, {
      headless: Boolean(local.headless),
      coldBoot: Boolean(local.coldBoot),
      wipeData: Boolean(local.wipeData),
    });
    output(
      { schemaVersion: SCHEMA_VERSION, avd: started },
      options,
      `Started ${started.name} (pid ${started.pid}). It will appear in serve-droid devices after Android finishes booting.`,
    );
  });

avd
  .command("stop <serial>")
  .description("Stop one running Android emulator selected by its ADB serial.")
  .action(async (serial, _local, command) => {
    const options = globalOptions(command);
    const adb = await client();
    const device = selectDevice(await listDevices(adb), serial);
    if (device.kind !== "emulator") {
      throw new ServeDroidError("INVALID_ARGUMENT", `${serial} is a physical device, not an AVD.`);
    }
    const result = await adb.run(["emu", "kill"], { serial: device.serial });
    if (result.exitCode !== 0) {
      throw new ServeDroidError(
        "EMULATOR_FAILED",
        result.stderr.trim() || "Emulator did not stop.",
      );
    }
    output(
      { schemaVersion: SCHEMA_VERSION, stopped: device.serial },
      options,
      `Stopped ${device.serial}.`,
    );
  });

program
  .command("start [device]")
  .description("Start the authenticated browser cockpit.")
  .option("--host <host>", "listen host", "127.0.0.1")
  .option("--port <port>", "listen port", (value) => Number.parseInt(value, 10), 0)
  .option("--token <token>", "fixed bearer token")
  .option("--record <directory>", "opt in to bounded H.264 and redacted event recording")
  .option(
    "--record-max-mb <megabytes>",
    "maximum recording size",
    (value) => Number.parseInt(value, 10),
    1024,
  )
  .option(
    "--record-max-minutes <minutes>",
    "maximum recording duration",
    (value) => Number.parseInt(value, 10),
    60,
  )
  .option("--audio", "enable Android playback capture; browser playback remains muted")
  .option("--detach", "run in the background")
  .option("--child", "internal detached child mode")
  .action(async (device, local, command) => {
    const options = { ...globalOptions(command), device: device ?? globalOptions(command).device };
    if (local.detach && !local.child) {
      const args = [
        process.argv[1]!,
        "start",
        ...(options.device ? [options.device] : []),
        "--child",
        "--host",
        local.host,
        "--port",
        String(local.port),
        "--json",
      ];
      if (local.token) args.push("--token", local.token);
      if (local.record) {
        args.push(
          "--record",
          resolve(local.record),
          "--record-max-mb",
          String(local.recordMaxMb),
          "--record-max-minutes",
          String(local.recordMaxMinutes),
        );
      }
      if (local.audio) args.push("--audio");
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const state = (await readSessionStates()).find(
          (session) =>
            !options.device ||
            session.device.serial === options.device ||
            session.device.model === options.device,
        );
        if (state && state.pid === child.pid) {
          output(
            { ...state, token: undefined },
            options,
            `serve-droid: ${state.url}\nDevice: ${state.device.model ?? state.device.serial}\nToken: ${state.token}${state.recordingDirectory ? `\nRecording: ${state.recordingDirectory}` : ""}`,
          );
          return;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      throw new ServeDroidError(
        "TRANSPORT_FAILED",
        "Detached server did not become ready within 10 seconds.",
      );
    }
    const server = new ServeDroidServer(await service(options), {
      host: local.host,
      port: local.port,
      token: local.token,
      ...(local.record
        ? {
            recording: {
              directory: resolve(local.record),
              maxBytes: Number(local.recordMaxMb) * 1024 * 1024,
              maxDurationMs: Number(local.recordMaxMinutes) * 60_000,
            },
          }
        : {}),
      audio: Boolean(local.audio),
    });
    const session = await server.start();
    output(
      { ...session, token: undefined, recording: server.recording },
      options,
      `serve-droid: ${session.url}\nDevice: ${session.device.model ?? session.device.serial}\nToken: ${server.token}${server.recording ? `\nRecording: ${server.recording.directory}` : ""}`,
    );
    const stop = () => void server.stop().finally(() => process.exit());
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

const tunnel = program
  .command("tunnel")
  .description("Create explicitly authorized, expiring remote access for a live session.");

tunnel
  .command("start [device]")
  .description("Run a preconfigured named Cloudflare Tunnel in the foreground.")
  .requiredOption("--tunnel <name>", "existing named Cloudflare tunnel")
  .requiredOption("--credentials-file <path>", "tunnel-specific credentials JSON")
  .requiredOption("--public-url <https-origin>", "preconfigured public HTTPS origin")
  .option(
    "--expires-minutes <minutes>",
    "hard lifetime from 1 to 120 minutes",
    (value) => Number.parseInt(value, 10),
    30,
  )
  .option("--cloudflared <path>", "explicit cloudflared executable")
  .option("--yes", "confirm public remote access")
  .action(async (device, local, command) => {
    const options = globalOptions(command);
    if (!local.yes) {
      throw new ServeDroidError(
        "INVALID_ARGUMENT",
        "Remote access publishes the selected session; rerun with --yes after reviewing docs/tunnels.md.",
      );
    }
    const matches = (await readSessionStates()).filter(
      (session) =>
        !device ||
        session.device.serial === device ||
        session.device.model?.toLowerCase() === String(device).toLowerCase(),
    );
    if (matches.length !== 1) {
      throw new ServeDroidError(
        matches.length ? "DEVICE_AMBIGUOUS" : "SESSION_NOT_FOUND",
        matches.length
          ? "Tunnel device selection is ambiguous."
          : "No matching live session exists.",
      );
    }
    const session = matches[0]!;
    const manager = new NamedCloudflareTunnel({
      executable: await resolveCloudflaredPath(local.cloudflared),
      tunnel: local.tunnel,
      credentialsFile: resolve(local.credentialsFile),
      publicUrl: local.publicUrl,
      durationMs: Number(local.expiresMinutes) * 60_000,
      session,
    });
    const stop = () => void manager.stop().finally(() => process.exit());
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const status = await manager.start();
    output(
      { schemaVersion: SCHEMA_VERSION, ...status, sessionUrl: session.url },
      options,
      `Remote access active until ${status.expiresAt}\nOpen: ${status.publicUrl}/#token=${session.token}\nCtrl-C revokes the connector immediately.`,
    );
    await new Promise<void>((resolvePromise) => manager.once("close", () => resolvePromise()));
  });

program.action(async () => {
  await program.parseAsync([process.argv[0]!, process.argv[1]!, "start", ...process.argv.slice(2)]);
});

program
  .command("list")
  .description("List live serve-droid sessions.")
  .action(async (_options, command) => {
    const options = globalOptions(command);
    const sessions = [];
    for (const session of await readSessionStates()) {
      try {
        const response = await fetch(`${session.url}/api/v1/health`, {
          signal: AbortSignal.timeout(750),
        });
        if (response.ok) sessions.push({ ...session, token: undefined });
        else await removeSessionState(session.device.serial);
      } catch {
        await removeSessionState(session.device.serial);
      }
    }
    output(
      { schemaVersion: SCHEMA_VERSION, sessions },
      options,
      sessions
        .map((session) => `${session.device.serial}\t${session.url}\tpid ${session.pid}`)
        .join("\n") || "No live sessions.",
    );
  });

program
  .command("stop [device]")
  .description("Stop one or all serve-droid sessions.")
  .option("--all", "stop all sessions")
  .action(async (device, local, command) => {
    const options = globalOptions(command);
    const sessions = (await readSessionStates()).filter(
      (session) => local.all || session.device.serial === device || session.device.model === device,
    );
    if (!local.all && !device)
      throw new ServeDroidError("INVALID_ARGUMENT", "Pass a device or --all.");
    for (const session of sessions) {
      process.kill(session.pid, "SIGTERM");
      await removeSessionState(session.device.serial);
    }
    output(
      { schemaVersion: SCHEMA_VERSION, stopped: sessions.map((session) => session.device.serial) },
      options,
      `Stopped ${sessions.length} session(s).`,
    );
  });

const recording = program.command("recording").description("Recover or remove local recordings.");

recording
  .command("recover <root-directory>")
  .description("Mark recordings left by dead serve-droid processes as crashed.")
  .action(async (root, _local, command) => {
    const options = globalOptions(command);
    const recovered = await recoverPartialRecordings(resolve(root));
    output(
      { schemaVersion: SCHEMA_VERSION, recovered },
      options,
      `Recovered ${recovered.length} partial recording(s).`,
    );
  });

recording
  .command("remove <session-directory>")
  .description("Permanently remove one recognized, inactive serve-droid recording.")
  .requiredOption("--yes", "confirm permanent removal")
  .action(async (directory, _local, command) => {
    const options = globalOptions(command);
    const target = resolve(directory);
    await removeRecording(target);
    output({ schemaVersion: SCHEMA_VERSION, removed: target }, options, `Removed ${target}.`);
  });

program
  .command("observe")
  .option("--since <cursor>", "log cursor", "0")
  .description("Capture UI hierarchy, foreground state, display, and incremental logs.")
  .action(async (local, command) => {
    const options = globalOptions(command);
    const current = await service(options);
    const observation = await current.observe(local.since);
    output({ ...observation, screenshot: null }, options);
  });

program
  .command("logs")
  .description("Read bounded structured Logcat entries.")
  .option("--follow", "follow new entries")
  .option("--package <id>", "filter to the current PID of a package")
  .option("--since <cursor>", "numeric cursor", "0")
  .option("--limit <count>", "maximum snapshot entries", (value) => Number.parseInt(value, 10), 500)
  .action(async (local, command) => {
    const options = globalOptions(command);
    const current = await service(options);
    if (!local.follow) {
      const snapshot = await current.logSnapshot({
        packageName: local.package,
        since: local.since,
        limit: local.limit,
      });
      output({ schemaVersion: SCHEMA_VERSION, ...snapshot }, options);
      return;
    }
    current.startLogs();
    const write = (entry: unknown) => output(entry, options, JSON.stringify(entry));
    current.logs.on("entry", write);
    const stop = () => {
      current.logs.off("entry", write);
      current.stop();
      process.exit();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

program
  .command("screenshot")
  .option("-o, --output <path>", "output JPEG path", "screenshot.jpg")
  .action(async (local, command) => {
    const options = globalOptions(command);
    const path = resolve(local.output);
    await writeFile(path, await (await service(options)).screenshot());
    output({ schemaVersion: SCHEMA_VERSION, path }, options, path);
  });

program.command("tree").action(async (_local, command) => {
  const options = globalOptions(command);
  output(
    { schemaVersion: SCHEMA_VERSION, elements: await (await service(options)).tree() },
    options,
  );
});

program.command("tap <x> <y>").action(async (x, y, _local, command) => {
  const options = globalOptions(command);
  await (await service(options)).actions.tap(Number(x), Number(y));
  output({ schemaVersion: SCHEMA_VERSION, ok: true }, options, "Tapped.");
});

program
  .command("swipe <x1> <y1> <x2> <y2>")
  .option("--duration <ms>", "duration", (value) => Number.parseInt(value, 10), 300)
  .action(async (x1, y1, x2, y2, local, command) => {
    const options = globalOptions(command);
    await (
      await service(options)
    ).actions.swipe(Number(x1), Number(y1), Number(x2), Number(y2), local.duration);
    output({ schemaVersion: SCHEMA_VERSION, ok: true }, options, "Swiped.");
  });

program.command("gesture <json>").action(async (value, _local, command) => {
  const options = globalOptions(command);
  let gesture: { points: Array<{ x: number; y: number; durationMs?: number }> };
  try {
    gesture = JSON.parse(value) as typeof gesture;
  } catch {
    throw new ServeDroidError("INVALID_ARGUMENT", "Gesture must be valid JSON.");
  }
  await (await service(options)).actions.gesture(gesture);
  output({ schemaVersion: SCHEMA_VERSION, ok: true }, options, "Gesture completed.");
});

program.command("type <text>").action(async (value, _local, command) => {
  const options = globalOptions(command);
  await (await service(options)).actions.typeText(value);
  output({ schemaVersion: SCHEMA_VERSION, ok: true }, options, "Text entered.");
});

program.command("key <key>").action(async (key, _local, command) => {
  const options = globalOptions(command);
  await (await service(options)).actions.key(key);
  output({ schemaVersion: SCHEMA_VERSION, ok: true }, options, "Key pressed.");
});

program.command("rotate <orientation>").action(async (orientation, _local, command) => {
  const options = globalOptions(command);
  await (await service(options)).actions.rotate(orientation);
  output({ schemaVersion: SCHEMA_VERSION, ok: true }, options, "Rotated.");
});

const app = program.command("app").description("Manage Android apps.");
app.command("install <apk>").action(async (apk, _local, command) => {
  const options = globalOptions(command);
  await (await service(options)).actions.install(resolve(apk));
  output({ schemaVersion: SCHEMA_VERSION, ok: true }, options, "Installed.");
});
app
  .command("launch <package>")
  .option("--activity <activity>")
  .action(async (packageName, local, command) => {
    const options = globalOptions(command);
    await (await service(options)).actions.launch(packageName, local.activity);
    output({ schemaVersion: SCHEMA_VERSION, ok: true }, options, "Launched.");
  });
app.command("stop <package>").action(async (packageName, _local, command) => {
  const options = globalOptions(command);
  await (await service(options)).actions.stop(packageName);
  output({ schemaVersion: SCHEMA_VERSION, ok: true }, options, "Stopped.");
});
for (const operation of ["clear", "uninstall"] as const) {
  app
    .command(`${operation} <package>`)
    .requiredOption("--yes", "confirm destructive operation")
    .action(async (packageName, _local, command) => {
      const options = globalOptions(command);
      const actions = (await service(options)).actions;
      await actions[operation](packageName);
      output({ schemaVersion: SCHEMA_VERSION, ok: true }, options, `${operation} completed.`);
    });
}
app
  .command("deep-link <url>")
  .option("--package <package>")
  .action(async (url, local, command) => {
    const options = globalOptions(command);
    await (await service(options)).actions.deepLink(url, local.package);
    output({ schemaVersion: SCHEMA_VERSION, ok: true }, options, "Deep link opened.");
  });

const permissions = program
  .command("permissions")
  .description("Manage Android runtime permissions.");
for (const operation of ["grant", "revoke", "reset", "list"] as const) {
  permissions
    .command(`${operation} <permission> <package>`)
    .action(async (permission, packageName, _local, command) => {
      const options = globalOptions(command);
      const result = await (
        await service(options)
      ).actions.permission(operation, permission, packageName);
      output(
        { schemaVersion: SCHEMA_VERSION, ok: true, output: result },
        options,
        result || `${operation} completed.`,
      );
    });
}

program
  .command("push <local-file> [remote-directory]")
  .action(async (path, remote, _local, command) => {
    const options = globalOptions(command);
    const destination = await (await service(options)).actions.push(resolve(path), remote);
    output({ schemaVersion: SCHEMA_VERSION, destination }, options, destination);
  });

program.command("mcp").description("Run the MCP server over stdio.").action(runMcpServer);

program.parseAsync().catch((error: unknown) => {
  const body =
    error instanceof ServeDroidError
      ? {
          schemaVersion: SCHEMA_VERSION,
          error: { code: error.code, message: error.message, details: error.details },
        }
      : {
          schemaVersion: SCHEMA_VERSION,
          error: {
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        };
  process.stderr.write(`${JSON.stringify(body)}\n`);
  process.exitCode = errorExitCode(error);
});
