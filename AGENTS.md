# Agent instructions

## Workflow and repository hygiene

- Work on an isolated worktree or single-purpose feature branch. Never develop directly on `main`.
- Keep each branch reviewable and narrowly scoped. Rebase onto the current `main` before final
  verification, and prefer a squash merge so diagnostic or formatting iterations do not pollute the
  default branch history.
- Remove temporary workflows, probes, patch scripts, generated traces, and debugging artifacts
  before final review. Verify the final changed-file list instead of assuming cleanup succeeded.
- Run `pnpm verify` before claiming completion. Run the full browser suite for cockpit/web changes,
  and use the Android fixture/API 35 gates whenever device behavior may be affected.
- Every user-visible behavior change needs a Changeset and the relevant long-form documentation or
  release-checklist update.
- Keep `README.md` aligned with the current product. Visible cockpit changes must regenerate the
  reproducible `docs/assets/serve-droid-cockpit.jpg` through `pnpm screenshot:readme`; that documented
  demo asset is the only intentional exception to the general no-session-screenshot rule below.

## Product and API boundaries

- Use `--json` for machine-readable CLI output.
- Never parse human CLI text, guess coordinates after a missing UI element, or invoke arbitrary ADB
  shell commands through public interfaces.
- All coordinates are normalized to `0..1` and refer to the current logical orientation.
- Do not weaken loopback binding, bearer authentication, origin confinement, payload bounds, or
  privacy filtering to make a feature easier to implement.
- Do not invent device metrics, progress percentages, frame-rate claims, latency values, or other
  live data. Surface measurements only when they are actually collected with a defined contract.
- Do not commit generated APKs, tokens, state files, recordings, ad-hoc/session screenshots, traces,
  Android SDK files, or local environment data.
- Real-device claims require `SERVE_DROID_DEVICE_TEST=1` evidence and the tested device matrix.

## Browser cockpit craft

- Keep the live Android surface as the primary visual focus. Controls and inspector tools are
  contextual workspace chrome, not equal-weight dashboard cards.
- Avoid nested-card density, tiny decorative labels, unnecessary badges, and fake dashboard
  ornamentation. Prefer hierarchy, spacing, disclosure, and progressive detail.
- Preserve accessible names, keyboard focus, semantic roles, live-region behavior, responsive
  layouts, and `prefers-reduced-motion` handling when polishing the UI.
- Follow the Emil Kowalski design-engineering bar for motion: every animation needs a functional
  purpose; high-frequency navigation, keyboard actions, live log rows, and tab switches stay
  instant. Ordinary UI motion stays below 300 ms, uses strong ease-out curves for enter/exit, and
  prefers `transform`/`opacity` over layout properties.
- Press feedback should be subtle (`scale(0.95–0.98)`), hover motion must be gated behind fine-pointer
  media queries, and trigger-anchored popovers should use a physically correct transform origin.
- Never use `ease-in` for interactive UI, `scale(0)` entrances, `transition: all`, or decorative
  motion that makes debugging tools slower to read.
- For visual changes, add or update Playwright assertions for stable behavioral/geometric properties
  instead of brittle pixel snapshots. Regenerate the README screenshot only after those tests pass.

## Code quality

- Prefer small testable modules over growing orchestration files. When a component or command owns a
  distinct state machine or concern, extract it instead of extending an existing monolith.
- Centralize validation, redaction, session selection, and transport policy instead of duplicating
  subtly different versions in CLI, HTTP, MCP, recording, or browser code.
- Fail closed at external boundaries. Bound memory, file sizes, payloads, queues, retries, timeouts,
  and retained history explicitly, and cover recovery behavior in tests.
