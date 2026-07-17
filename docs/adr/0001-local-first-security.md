# ADR 0001: local-first authenticated sessions

Status: accepted.

serve-droid binds to loopback and authenticates every non-health endpoint. LAN exposure is explicit
and retains authentication. There is no arbitrary shell tool. This protects devices from accidental
network exposure while retaining browser and agent interoperability.
