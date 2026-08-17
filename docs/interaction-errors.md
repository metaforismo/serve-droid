# Interaction failure diagnostics

serve-droid preserves generic transport and ADB failures unless Android provides evidence for a more
specific diagnosis. A `SecurityException` by itself is not enough to classify a device or screen.

## Stable error codes

| Code               | Meaning                                                                                  | Retry guidance                         |
| ------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------- |
| `DEVICE_LOCKED`    | A failed interaction was followed by explicit keyguard showing or input-restricted state | Wake and unlock the device, then retry |
| `SECURE_SCREEN`    | The same keyguard evidence also reports a secure lock screen                              | Unlock the device, then retry          |
| `INPUT_RESTRICTED` | Android or an OEM/enterprise policy explicitly rejected input injection                   | Change the device policy or test device |
| `ADB_FAILED`       | No safe, specific classification was available                                            | Inspect the bounded Android message    |
| `TRANSPORT_FAILED` | A scrcpy control transport failed without an explicit Android policy rejection            | Reconnect or restart the session       |

These codes use the existing device-error CLI exit status. HTTP and control-WebSocket responses keep
the same versioned error envelope and include structured `details` such as the operation, serial,
retry boundary, and bounded keyguard evidence.

## Detection boundary

Successful interactions do not perform extra ADB calls. After an ADB input, UI hierarchy, or
screenshot command fails, serve-droid may run at most two fixed, bounded diagnostic commands:

```text
adb shell dumpsys window policy
adb shell dumpsys activity activities
```

The parser only accepts boolean fields inside recognized Android keyguard blocks, including
`KeyguardServiceDelegate`, `KeyguardStateMonitor`, and `KeyguardController`. Unrelated values such as
another service's `showing=true` are ignored. Diagnostic output is capped at 256 KiB and each command
has a three-second timeout.

An explicit input-policy classification requires input-injection language together with a permission
or policy signal. Examples include Android's `INJECT_EVENTS` permission rejection and OEM messages
that state input injection is disabled, blocked, forbidden, or not permitted. An unrelated permission
error remains `ADB_FAILED`.

The scrcpy control protocol does not acknowledge whether Android ultimately consumed each event.
serve-droid can therefore map an explicit policy exception raised by the control writer, but an
ordinary socket failure remains `TRANSPORT_FAILED`. It is never replayed through ADB after injection
has begun.

## Privacy and limitations

Input command arguments are not copied into structured failure details, so typed text is not echoed
through HTTP, CLI JSON, or MCP error metadata. The human-readable Android error is bounded before it
is returned.

Some Android builds may accept an input command but ignore the event, and windows using
`FLAG_SECURE` may produce protected or blank video without returning an error. serve-droid does not
invent a typed diagnosis in those cases. Real-device release evidence must still cover secure apps,
keyguard transitions, and OEM debugging policies on the supported device matrix.
