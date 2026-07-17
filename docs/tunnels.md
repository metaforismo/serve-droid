# Authenticated remote tunnels

Remote access is opt-in, foreground-only, and intended for short debugging sessions. serve-droid
supports an existing **named Cloudflare Tunnel**; it does not create provider accounts, DNS records,
tunnel credentials, or persistent services.

Quick Tunnels are deliberately unsupported. Cloudflare documents them as development-only, without
an uptime guarantee, and without Server-Sent Events. The missing SSE support would break
serve-droid's incremental Logcat endpoint. Configure a named tunnel and DNS hostname in Cloudflare
first, then install `cloudflared` from Cloudflare's official package.

```bash
serve-droid start --detach
serve-droid tunnel start emulator-5554 \
  --tunnel serve-droid-debug \
  --credentials-file ~/.cloudflared/TUNNEL-ID.json \
  --public-url https://android-debug.example.com \
  --expires-minutes 30 \
  --yes
```

The credentials file must be tunnel-specific and mode `0600` on macOS/Linux. serve-droid writes a
private temporary config that maps the exact hostname to the selected loopback session, starts
`cloudflared` without a shell or auto-update, and verifies the public `/api/v1/health` endpoint. It
does not parse human CLI output. The temporary config is removed on failure, expiry, Ctrl-C,
SIGTERM, or connector exit.

Machine-readable output contains the public origin and expiry but never the session token. Human
output shows a share URL with the token in the URL fragment (`#token=...`). Browsers do not send URL
fragments in HTTP requests, and the cockpit removes the fragment from browser history immediately.
Never move the token into a query string. Anyone holding the token has full read and control access
to that Android session.

## Threat model and lifecycle

- Consent is mandatory through `--yes`; there is no detached tunnel mode.
- Lifetimes are limited to 1–120 minutes and default to 30 minutes.
- Ctrl-C or SIGTERM kills the connector immediately. Expiry does the same automatically.
- The cockpit shows a visible remote-access badge and expiry while the connector is active.
- The origin stays bound to `127.0.0.1`; only `cloudflared` can reach it locally.
- The existing random bearer token still protects reads, actions, files, video, audio, and control.
- Only an exact HTTPS origin is accepted. Credentials, paths, queries, and fragments are rejected.
- Public readiness checks reject redirects, limiting hostile DNS or captive-portal confusion.
- Connector exit revokes visible state; `cloudflared` owns transient edge reconnect/backoff.
- Cloudflare terminates public TLS and can observe connection metadata. Cloudflare Access can be an
  additional outer policy, but the public health readiness route needs an explicit bypass or a
  future service-token integration; serve-droid bearer auth remains required behind it.
- Revoking the connector does not rotate the serve-droid token. Stop the underlying session if a
  recipient or token may be compromised.

Named tunnel credentials do not expire automatically and can run that tunnel. Store and rotate them
according to Cloudflare's guidance. Never commit credentials, generated tunnel configs, or tokens.
