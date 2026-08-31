import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  // MV3 for both engines off one source (DESIGN.md "Approach"). WXT
  // defaults Firefox to MV2 unless told otherwise.
  manifestVersion: 3,
  vite: () => ({
    plugins: [
      tailwindcss(),
      {
        // Strip content hashes out of emitted filenames.
        //
        // Rollup's hash folds in module ids, which carry the absolute build
        // path, so the same source built from a different directory emits
        // different chunk names — and every file that names a chunk (the
        // other chunks, the CSS, both HTML entrypoints) then differs too.
        // AMO rebuilds a submitted sources archive and diffs the result
        // against the uploaded package, requiring no differences at all, so
        // a path-dependent name is a rejection risk rather than a cosmetic
        // one. Cache busting buys nothing here: these files load from the
        // extension bundle, never over a network.
        //
        // WXT sets these itself in getMultiPageConfig and its config merges
        // after this one, so the `vite` option cannot override them. Rollup's
        // outputOptions hook runs late enough to win. Rather than restate
        // WXT's routing (html entrypoints go to chunks/, background.js stays
        // at the root) this keeps its own value and removes only the token.
        name: 'tailnet-bookmarks:deterministic-filenames',
        outputOptions(options) {
          const entry = options.entryFileNames;
          return {
            ...options,
            chunkFileNames: 'chunks/[name].js',
            assetFileNames: 'assets/[name].[ext]',
            entryFileNames:
              typeof entry === 'function'
                ? (info) => String(entry(info)).replace('-[hash]', '')
                : String(entry ?? '[name].js').replace('-[hash]', ''),
          };
        },
      },
    ],
  }),
  manifest: ({ browser }) => ({
    // The display name, in both store listings and each browser's own
    // extensions manager. Set here rather than taken from package.json,
    // whose name has to stay a valid npm package name.
    name: 'Tailnet Bookmarks',
    permissions: ['bookmarks', 'alarms', 'storage'],
    host_permissions: ['https://api.tailscale.com/*'],
    // Firefox needs a stable id for storage.sync and AMO signing.
    // DESIGN.md "Cross-browser notes".
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'tailnet-bookmarks@tylerjohnson.me',
              // Nothing is collected or transmitted: credentials are typed
              // per machine and go only to api.tailscale.com, the device
              // and service lists become local bookmarks, and there is no
              // telemetry. Required on new AMO submissions from 3 Nov 2025.
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : {}),
  }),
});
