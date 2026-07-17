# Security policy

Report vulnerabilities with a private GitHub security advisory, not a public issue.

serve-droid exposes the contents and controls of an Android device. It binds to `127.0.0.1` by
default and authenticates all non-health endpoints. Treat the generated token like a password.

Binding to `0.0.0.0` exposes the service to the local network. Use only trusted networks, preserve
authentication, prefer an authenticated encrypted reverse proxy, and do not expose ADB port 5555
to the public internet.

Supported security fixes are released for the latest minor version.
