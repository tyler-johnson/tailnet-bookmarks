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
    plugins: [tailwindcss()],
  }),
  manifest: ({ browser }) => ({
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
