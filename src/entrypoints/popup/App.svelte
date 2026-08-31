<script lang="ts">
  // Real status (last sync time, badge state, manual sync trigger) lands
  // once background reconciliation exists. This is scaffolding only.
  let status = $state<'idle' | 'setup'>('setup');
</script>

<main class="flex w-72 flex-col gap-4 bg-base-100 p-4 text-base-content">
  <h1 class="text-lg font-semibold">Tailnet Bookmarks</h1>

  {#if status === 'setup'}
    <div role="alert" class="alert alert-warning">
      <span>Not configured yet. Open options to add a Tailscale OAuth client.</span>
    </div>
  {/if}

  <button type="button" class="btn btn-primary btn-sm">Sync now</button>
</main>
