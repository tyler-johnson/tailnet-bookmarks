# Tailnet Bookmarks

Mirrors your Tailscale Devices and Services into a browser bookmarks folder.

Your tailnet already names every device and service. This keeps one bookmarks folder pointed at them — real bookmarks, usable from the address bar, from search, and from the bookmarks menu. It reads your tailnet on a timer, and only ever reads it.

Firefox and Chromium, from one MV3 source.

## Setup

Create a Tailscale OAuth client under **Settings → Trust Credentials** in the admin console, with exactly two read-only scopes:

- General › Services — Read
- Devices › Core — Read

Enter the client id and secret on the extension's options page. The secret is stored in `storage.local` on the machine you type it on and is never synced. Folder location, poll interval and the source toggles live in `storage.sync`, so every machine on your browser account computes the same folder.

## Behavior worth knowing

The folder is fully managed: bookmarks you add to it by hand are removed on a later sync. Nested folders inside it are left alone as an escape hatch.

Running it on several machines at once is safe. They compute the same desired set and converge on one folder rather than fighting over it — which matters because the folder itself replicates through browser sync. [DESIGN.md](DESIGN.md) explains how, and `src/test/convergence/` is the evidence: a harness that models two browsers and a sync channel and asserts the op stream goes empty and stays empty.

## Build

Requires Node.js 20 or newer.

```
npm ci
npm test                  # 149 tests
npx wxt zip               # Chromium
npx wxt zip -b firefox    # Firefox, plus the sources archive AMO asks for
```

Builds are deterministic: emitted filenames carry no content hashes and the stylesheet is generated from a declared source directory, so a rebuild from the sources archive matches the shipped package byte for byte.

## Privacy

It handles the user's own Tailscale credentials, locally, and sends nothing to the developer. [PRIVACY.md](PRIVACY.md) is the full statement.

## License

MIT, see [LICENSE](LICENSE).

Bundles [Inter](https://github.com/rsms/inter) under the SIL Open Font License 1.1, see `src/assets/fonts/LICENSE-Inter.txt`.
