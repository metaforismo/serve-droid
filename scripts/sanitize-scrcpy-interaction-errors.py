from pathlib import Path

control_path = Path("packages/server/src/control.ts")
control = control_path.read_text(encoding="utf-8")
old_import = "  ServeDroidError,\n  inputRestrictionError,\n"
new_import = "  ServeDroidError,\n  boundedInteractionMessage,\n  inputRestrictionError,\n"
if new_import not in control:
    if old_import not in control:
        raise SystemExit("control import marker was not found")
    control = control.replace(old_import, new_import, 1)
old_cause = '''function errorCause(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 160);
}'''
new_cause = '''function errorCause(error: unknown): string {
  return boundedInteractionMessage(error instanceof Error ? error.message : String(error)).slice(
    0,
    160,
  );
}'''
if new_cause not in control:
    if old_cause not in control:
        raise SystemExit("control errorCause marker was not found")
    control = control.replace(old_cause, new_cause, 1)
control_path.write_text(control, encoding="utf-8")

test_path = Path("packages/server/test/typed-input-errors.test.ts")
tests = test_path.read_text(encoding="utf-8")
old_fixture = 'new RejectingWriter("control socket closed")'
new_fixture = 'new RejectingWriter("\\u001b[31mcontrol socket closed\\u001b[0m")'
if new_fixture not in tests:
    if old_fixture not in tests:
        raise SystemExit("scrcpy sanitization fixture was not found")
    tests = tests.replace(old_fixture, new_fixture, 1)
test_path.write_text(tests, encoding="utf-8")

doc_path = Path("docs/interaction-errors.md")
doc = doc_path.read_text(encoding="utf-8")
old_doc = "another service's `showing=true` are ignored. Diagnostic output is capped at 256 KiB and each command\nhas a three-second timeout."
new_doc = "another service's `showing=true` are ignored. The parser inspects at most the first 256 KiB of each\nreturned dump, and each command has a three-second timeout."
if new_doc not in doc:
    if old_doc not in doc:
        raise SystemExit("diagnostic output documentation marker was not found")
    doc = doc.replace(old_doc, new_doc, 1)
doc_path.write_text(doc, encoding="utf-8")
