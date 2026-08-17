from pathlib import Path

path = Path("packages/core/src/interaction-errors.ts")
content = path.read_text(encoding="utf-8")

old_locked = '''  const locked =
    inputRestricted === true || showing === true || aodShowing === true
      ? true
      : showing === false && aodShowing !== true && inputRestricted !== true
        ? false
        : null;'''
new_locked = '''  const locked =
    inputRestricted === true || showing === true || aodShowing === true
      ? true
      : showing === false
        ? false
        : null;'''
if new_locked not in content:
    if old_locked not in content:
        raise SystemExit("generated locked-state marker was not found")
    content = content.replace(old_locked, new_locked, 1)

old_run = '''  const result = await adb.run(args, {
    serial: options.serial,
    timeoutMs: options.timeoutMs,
  });'''
new_run = '''  const runOptions =
    options.timeoutMs === undefined
      ? { serial: options.serial }
      : { serial: options.serial, timeoutMs: options.timeoutMs };
  const result = await adb.run(args, runOptions);'''
if new_run not in content:
    if old_run not in content:
        raise SystemExit("interaction command options marker was not found")
    content = content.replace(old_run, new_run, 1)

path.write_text(content, encoding="utf-8")
