# Tailnet Bookmarks

Design note · v0.2 — high level · Aug 2026 · Status: prototype working

## Problem

Devices and Services on the tailnet are already declared, named, and reachable by stable MagicDNS names — but nothing keeps a browser's bookmarks aligned with them. Things get added, renamed, and retired; the folder drifts and gets hand-edited until it's wrong. Firefox removed Live Bookmarks in v64, so there's no built-in mechanism for a folder whose contents come from somewhere else.

## Goal

One bookmarks folder in Firefox that mirrors the current tailnet — both Devices and the Services declared on the Services page — maintained without manual edits. Real bookmarks: clickable from the URL bar, searchable in awesomebar, usable from the bookmarks menu. Not a sidebar, not a dashboard page, not a link to something else.

## Non-goals

- Routing traffic, exit nodes, or anything touching the Tailscale data plane. This reads metadata and writes bookmarks.
- Replacing the Tailscale client or admin console.
- Multi-user or hosted operation. Single user, own tailnet, own credentials.
- Service discovery. Services come from what's declared in the tailnet. The extension does not probe hosts, read Compose files, or infer ports.
- Managing tailnet state. Read-only — it never creates, edits, or removes Devices or Services.

## Approach

A Firefox WebExtension owns one bookmarks folder and treats it as a projection of remote state. On a timer it fetches the Device and Service lists, computes the desired set of bookmarks, and reconciles the folder against it. The `browser.bookmarks` API is the only supported way to mutate bookmarks while Firefox is running — writing `places.sqlite` directly is not viable because Firefox holds the DB and caches bookmarks in memory.

```
alarm (default 30m)
  └─ POST /api/v2/oauth/token          client_credentials → 1h token
     ├─ GET /api/v2/tailnet/-/devices
     └─ GET /api/v2/tailnet/-/vip-services
        └─ build desired set            {url: title}
           └─ diff against folder       key on URL
              ├─ present, wrong title   → update
              ├─ absent from desired    → remove
              ├─ absent from folder     → create
              └─ desired set empty      → abort, keep folder
```

## Components

| Piece | Responsibility |
| --- | --- |
| background | Token lifecycle, Device and Service fetch, reconcile loop, alarm scheduling, status reporting. |
| options page | Credentials, folder location, poll interval, which sources to include. Manual sync trigger. |
| storage.local | Config, cached folder ID, last sync result. Access token is memory-only. |
| toolbar action | Sync on click; badge surfaces failure state. |

## Auth

A Tailscale OAuth client using the client credentials grant, scoped to reading devices and services. Chosen over a plain API access token because those cap at 90 days and carry full API permission; OAuth clients don't expire and are scope-limited. Tokens are short-lived, refreshed on demand, and never persisted.

> **Constraint:** the client secret lives in `storage.local`, unencrypted, on disk in the browser profile. Acceptable for a personal read-only devices scope; not acceptable for anything with write access, and a hard blocker on public distribution.

## Data model

Both sources are remote and authoritative; nothing about what exists is configured locally. Devices give a MagicDNS name and become a bare-host bookmark. Services give a name, a declared set of ports, and an optional comment — the ports determine the scheme and whether a port appears in the URL, and the comment becomes the bookmark label. The tailnet suffix is derived from the device list rather than configured, so nothing has to be entered twice. Reconciliation keys on the resulting URL, which keeps the diff idempotent and lets titles change without churning bookmark IDs.

## Known limits

- **Folder is fully managed.** Hand-added bookmarks in it are removed on the next sync. Nested folders are left alone as an escape hatch.
- **Shared devices are invisible.** OAuth-issued tokens only return devices owned by the tailnet, not ones shared in from another tailnet. A plain API token would see them, at the cost of 90-day rotation.
- **Undeclared services don't appear.** A container with a published port that isn't a declared Service isn't in the tailnet's model and won't be bookmarked. That's the contract, not a gap to close.
- **Service response shape unverified.** The vip-services payload key and port formatting are handled defensively until confirmed against a live tailnet.
- **Distribution requires signing.** Temporary add-ons die on browser restart. Permanent install means an unlisted AMO submission for a signed XPI.
- **No cross-tailnet sign-in.** Tailscale's authorization-code flow (OAuth apps, alpha) is restricted to users within the same tailnet, and Tailscale is not an identity provider by design. Any other user brings their own credentials.

## Open questions

- **Firefox Sync interaction** — if Sync is on, the folder replicates to other machines that may also be running the extension. Convenient, or two writers fighting?
- **Offline and stale devices** — include everything, filter on `lastSeen`, or annotate the title? Affects whether the folder is "my tailnet" or "what's up right now".
- **Device and Service overlap** — a Service and the host advertising it both get bookmarks. Redundant, or useful because one is the stable address and one is the box?
- **Unadvertised and draining Services** — a defined Service with no host currently advertising it still exists in the tailnet. Bookmark it, skip it, or label it?
- **Scope beyond Firefox** — the bookmarks API is near-identical in Chromium. Worth keeping the code portable, or not a real requirement?

---

Prototype: manifest v3, ~230 LOC, two API reads, loads via `about:debugging`.
