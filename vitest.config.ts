import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// Wires WXT's own vitest integration (auto-imports, manifest env) so any
// entrypoint- or `#imports`-touching code under test resolves the same
// way it does under `wxt build`. src/lib/tailscale itself does not need
// this — its browser-touching seam is explicit-imported and behind a
// substitutable interface (see src/lib/tailscale/session-store.ts) — but
// later flights testing background/options code will.
export default defineConfig({
  plugins: [WxtVitest()],
});
