# Privacy Policy

**Tailnet Bookmarks** · last updated 31 August 2026

Tailnet Bookmarks handles a small amount of data, all of it the user's own, and sends none of it to the developer.

## What it handles, and where that data lives

**Tailscale OAuth client id and secret.** Entered by the user on the extension's options page and stored in `storage.local`, which is local to the browser profile on the machine where they were typed. They are never synced between machines, and they are sent to exactly one place: `api.tailscale.com`, to obtain an access token.

**Tailscale API access token.** Short-lived, held in `storage.session`, which is memory-backed and cleared when the browser closes. It is never written to disk.

**Settings.** The bookmarks folder location, the poll interval, and the device and service toggles are stored in `storage.sync`. This is the browser's own sync storage, so if the user has browser sync enabled these settings replicate between their machines through Mozilla or Google, in the same way their bookmarks already do. The OAuth client secret is deliberately not stored here.

**Tailnet device and service lists.** Fetched from the Tailscale API, used to work out what the managed bookmarks folder should contain, and then discarded. They are not stored, and they are not sent anywhere.

**Bookmarks.** The extension reads the browser's bookmark tree in order to locate the one folder it manages, and creates, retitles, and removes entries inside that folder. It does not modify anything outside it, and it does not transmit bookmark data anywhere.

**Deletion bookkeeping.** A record of which URLs have been missing from the tailnet, and since when, is kept in `storage.local` so that a bookmark is only removed after it has been absent across two consecutive checks.

## Who the data is shared with

`api.tailscale.com`, and nobody else.

The extension makes requests to exactly three endpoints on that host: one to exchange the user's own OAuth client credentials for a short-lived token, and two to read the tailnet's device and service lists. It contacts no other server.

**No data is sent to the developer.** There is no telemetry, no analytics, no crash reporting, and no third-party service of any kind.

## What it does not do

It does not read the content of web pages, does not read or record browsing history, does not track activity, and contains no advertising or tracking code. It is read-only with respect to the tailnet: it never creates, edits, or removes devices or services.

## Contact

Questions and issues: https://github.com/tyler-johnson/tailnet-bookmarks/issues
