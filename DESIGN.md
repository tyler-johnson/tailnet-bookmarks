# Tailnet Bookmarks

Design note · v0.3 — decisions taken · Aug 2026 · Status: prototype working, rewrite pending

## Problem

Devices and Services on the tailnet are already declared, named, and reachable by stable MagicDNS names — but nothing keeps a browser's bookmarks aligned with them. Things get added, renamed, and retired; the folder drifts and gets hand-edited until it's wrong. Firefox removed Live Bookmarks in v64, so there's no built-in mechanism for a folder whose contents come from somewhere else.

## Goal

One bookmarks folder that mirrors the current tailnet — both Devices and the Services declared on the Services page — maintained without manual edits, in Firefox and in Chromium browsers. Real bookmarks: clickable from the URL bar, searchable in awesomebar, usable from the bookmarks menu. Not a sidebar, not a dashboard page, not a link to something else.

Because both the folder and the extension replicate through browser sync, a second requirement stands beside the first: **several machines running this against one account must not thrash the folder.** That is the hard part of the design and most of what follows is about it.

## Non-goals

- Routing traffic, exit nodes, or anything touching the Tailscale data plane. This reads metadata and writes bookmarks.
- Replacing the Tailscale client or admin console.
- Multi-user or hosted operation. Single user, own tailnet, own credentials.
- Service discovery. Services come from what's declared in the tailnet. The extension does not probe hosts, read Compose files, or infer ports.
- Managing tailnet state. Read-only — it never creates, edits, or removes Devices or Services.

## Approach

A WebExtension owns one bookmarks folder and treats it as a projection of remote state. On a timer it fetches the Device and Service lists, computes the desired set of bookmarks, and reconciles the folder against it. The `browser.bookmarks` API is the only supported way to mutate bookmarks while a browser is running — writing `places.sqlite` directly is not viable because Firefox holds the DB and caches bookmarks in memory.

One MV3 source builds for both engines through [WXT](https://wxt.dev), with a `manifest: ({ browser }) => …` function carrying the few real deltas. The bookmarks, alarms, storage, and permissions APIs are close enough between Firefox and Chromium that the polyfilled `browser` namespace covers the difference.

```
alarm (default 30m) · manual sync · startup + settle delay
  └─ config present?                     no → idle, badge "setup"
     └─ POST /api/v2/oauth/token         client_credentials → 1h token (storage.session)
        ├─ GET /api/v2/tailnet/-/devices      ok → devices slice  · fail → slice unknown
        └─ GET /api/v2/tailnet/-/vip-services ok → services slice · fail → slice unknown
           └─ every slice unknown → abort, keep folder
              └─ locate folder by derived name under parent
                 ├─ none       → create
                 └─ several    → keep oldest dateAdded, delete the rest
                    └─ hash(desired) == hash(folder) → done, zero writes
                       └─ plan(desired, actual) → ops
                          ├─ absent from folder             → create
                          ├─ present, wrong title           → update
                          ├─ duplicate URL                  → keep oldest dateAdded
                          └─ absent from desired, 2nd poll  → remove
```

## Sync and convergence

Browser sync replicates both the extension and the folder, so every machine on the account is a writer against the same folder. Three distinct hazards follow.

**Two writers.** If two machines' desired sets are ever unequal — even for one poll interval — one adds a bookmark, sync ships it to the other, the other sees it as absent from its own desired set and deletes it, sync ships the delete back, and the first re-adds. The loop does not terminate on its own.

**Independent creation.** Sync merges bookmarks by identity, not by URL. The same URL created on two machines is two records and survives the merge as a visible duplicate. The folder itself is worse: a machine's local bookmark id for the synced folder is not the id another machine cached, so an extension that trusts a cached id fails to find the folder and creates a second one.

**Late delivery.** Sync changes can land minutes after a browser starts. Reconciling against a half-synced tree produces a churn burst by construction.

The answer is not to arbitrate between writers — no lock, no leader, no lease. It is to make every writer compute the same answer and make agreement cost nothing, so concurrent writers are simply harmless. Five rules:

**Convergent identity.** The folder's name derives from the tailnet suffix in the device list, not from configuration, so machines pointed at different tailnets can never contend for one folder. It is located by name under the configured parent on every run; a cached id is validated before use and is only ever an optimization. Duplicate folders, and duplicate bookmarks on one URL, resolve by keeping the oldest `dateAdded` and deleting the rest — `dateAdded` replicates through sync, so every machine picks the same survivor without coordination.

**Minimal writes.** Reconciliation keys on URL. Index and ordering are never written; they are pure flap with nothing to show for it. A node whose title and URL already match is never rewritten. Before planning anything, a hash of the desired set is compared against a hash of the folder's current contents — equal means the run ends having touched nothing, which is the steady state, so a quiet tailnet costs zero bookmark writes per poll on every machine indefinitely.

**Per-source slices.** Every bookmark belongs to the devices slice or the services slice. A slice whose fetch failed is *unknown*, not empty, and is left entirely alone. This generalizes the older abort-on-empty rule and closes its real hole: a 500 from vip-services must not delete every service bookmark.

**Lagged deletes.** Additions apply immediately. A removal requires the URL to be absent from the desired set on two consecutive polls at least one interval apart, tracked as `{url: firstMissingAt}` in local storage. This is the anti-flap mechanism proper: transient disagreement between machines costs one stale bookmark for one interval rather than an unbounded loop.

**No event-driven reconcile.** `bookmarks.onChanged` and `onRemoved` fire for incoming sync changes, so reconciling on them amplifies exactly the feedback this design exists to prevent. The alarm and explicit user action are the only triggers, and the first run after startup waits out a settle delay.

Firefox Sync and Chrome Sync are separate networks. A Firefox machine and a Chromium machine never share the folder, so cross-browser support does not multiply this problem — it duplicates it independently on each side, where the same five rules hold.

## Components

| Piece | Responsibility |
| --- | --- |
| `planner` | `plan(desired, actual) → Op[]`. Pure, no browser API, no I/O. Where the five rules live. |
| `applier` | Executes ops against `browser.bookmarks`. Thin, no decisions. |
| `tailscale` | Token lifecycle and the two API reads. Returns slices that are explicitly present or unknown. |
| `background` | Alarm scheduling, settle delay, run orchestration, status and badge. |
| `options page` | Credentials, folder parent, poll interval, source toggles, host-permission grant, manual sync. |
| `storage` | `sync:` for shared config, `local:` for the secret and delete-lag state, `session:` for the access token. |

Keeping the planner pure is what makes the convergence claim testable: a harness that simulates two browsers and a sync channel between them can assert the op stream goes empty and stays empty. That test is the evidence the sync problem is solved; the rest is plumbing.

## Auth

A Tailscale OAuth client using the client credentials grant, scoped to reading devices and services. Chosen over a plain API access token because those cap at 90 days and carry full API permission; OAuth clients don't expire and are scope-limited. Tokens are short-lived and refreshed on demand.

The access token lives in `storage.session` — memory-backed, never written to disk, never synced, cleared on browser restart. Not in a module variable: Chromium terminates the MV3 service worker after roughly thirty seconds idle, which would discard the token between every poll and force a token request per run.

Configuration splits by sensitivity. Folder parent, poll interval, and source toggles live in `storage.sync`, so every machine on the account computes the same desired set from the same settings. The OAuth client secret lives in `storage.local` and is entered once per machine; it never leaves the machine it was typed on.

> **Constraint:** the client secret sits in `storage.local`, unencrypted, in the browser profile. Acceptable for a personal read-only scope; not acceptable for anything with write access, and a hard blocker on public distribution.

## Data model

Both sources are remote and authoritative; nothing about what exists is configured locally. Devices give a MagicDNS name and become a bare-host bookmark. Services give a name, a declared set of ports, and an optional comment — the ports determine the scheme and whether a port appears in the URL, and the comment becomes the bookmark label. The tailnet suffix is derived from the device list rather than configured, so nothing is entered twice and the folder name is a function of the tailnet. Reconciliation keys on the resulting URL, which keeps the diff idempotent and lets titles change without churning bookmark ids.

## Cross-browser notes

- **Firefox needs a stable extension id** — `browser_specific_settings.gecko.id` — for `storage.sync` and for AMO signing.
- **Host permissions are not silent in Firefox MV3.** From Firefox 127 they appear in the install prompt, but an update that adds new ones does not re-prompt. The options page checks `permissions.contains()` and offers `permissions.request()` for `api.tailscale.com` rather than assuming access.
- **The MV3 background differs.** Chromium runs a terminating service worker; Firefox runs an event page. Nothing may be held in module scope across runs — all state is in `storage`.
- **Alarms are the clock.** `browser.alarms` survives worker termination on both; `setTimeout` does not.
- **Distribution differs sharply.** Firefox takes an unlisted AMO submission for a signed XPI. Chromium has no unlisted-signing equivalent: it is the Web Store (private or unlisted listing), enterprise policy, or dev-mode unpacked. Both are to be signed and installed properly; the Chrome Web Store developer account and review latency are accepted cost.

## Known limits

- **Folder is fully managed.** Hand-added bookmarks in it are removed on the next sync — after the delete lag, so an accidental deletion of your own is recoverable within one interval. Nested folders are left alone as an escape hatch.
- **Shared devices are invisible.** OAuth-issued tokens only return devices owned by the tailnet, not ones shared in from another tailnet. A plain API token would see them, at the cost of 90-day rotation.
- **Undeclared services don't appear.** A container with a published port that isn't a declared Service isn't in the tailnet's model and won't be bookmarked. That's the contract, not a gap to close.
- **Service response shape unverified.** The vip-services payload key and port formatting are handled defensively until confirmed against a live tailnet.
- **A machine that never runs holds nothing back.** Convergence is between machines that actually poll; one that has been off for a month simply catches up on its next run.
- **No cross-tailnet sign-in.** Tailscale's authorization-code flow (OAuth apps, alpha) is restricted to users within the same tailnet, and Tailscale is not an identity provider by design. Any other user brings their own credentials.

## Open questions

- **Offline and stale devices** — include everything, filter on `lastSeen`, or annotate the title? Affects whether the folder is "my tailnet" or "what's up right now". Note that a `lastSeen` filter makes the desired set time-dependent and therefore machine-dependent, which is precisely the disagreement the delete lag is absorbing — a coarse threshold or none at all is the safer reading.
- **Device and Service overlap** — a Service and the host advertising it both get bookmarks. Redundant, or useful because one is the stable address and one is the box?
- **Unadvertised and draining Services** — a defined Service with no host currently advertising it still exists in the tailnet. Bookmark it, skip it, or label it?
- **Settle delay and interval** — how long after startup before the first run, and is 30m the right poll? Both are guesses until there is churn data from two live machines.
