<script lang="ts">
  // Full options UI (credentials, folder parent, poll interval, source
  // toggles, host-permission grant, manual sync) is flight #7's work.
  // This is scaffolding only, wired to prove the build pipeline.
  let clientId = $state('');
</script>

<main class="mx-auto flex max-w-md flex-col gap-6 bg-base-100 p-6 text-base-content">
  <h1 class="text-xl font-semibold">Tailnet Bookmarks</h1>

  <label class="flex w-full flex-col gap-2">
    <span class="text-sm font-medium">OAuth client ID</span>
    <input type="text" class="input w-full" bind:value={clientId} />
    <span class="text-xs text-base-content/70">From the Tailscale admin console.</span>
  </label>

  <button type="button" class="btn btn-primary">Save</button>
</main>
