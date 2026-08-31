<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '#imports';
  import { oauthClientId, oauthClientSecret, lastRunStatus, TAILSCALE_ORIGIN, type LastRunStatus } from '../../lib/storage';
  import { checkCanStart } from '../../lib/background';
  import { MANUAL_SYNC_MESSAGE_TYPE, isManualSyncResponse, type ManualSyncRequest } from '../../lib/messages';

  // Local-only reads — the popup never edits credentials or config, that's
  // the options page's job. It only needs enough to ask checkCanStart the
  // same question background asks itself before starting a run.
  let clientId = $state('');
  let clientSecret = $state('');
  let hostPermissionGranted = $state(false);

  let status = $state<LastRunStatus | null>(null);
  let loaded = $state(false);

  // Manual sync — mirrors the options page's own requestManualSync (see
  // src/entrypoints/options/App.svelte), including the "no receiver yet"
  // fallback below.
  let syncRequestState = $state<'idle' | 'sending' | 'sent' | 'error'>('idle');
  let syncRequestError = $state('');

  let unwatchStatus: (() => void) | undefined;

  // checkCanStart is the same function background uses to decide whether a
  // run can start, so this popup agreeing with background is by
  // construction, not a second opinion that can drift. Its error text
  // already distinguishes missing credentials from missing host
  // permission — rendered verbatim rather than collapsed into one
  // "not configured" message.
  const readiness = $derived(
    loaded
      ? checkCanStart({ clientId, clientSecret, hasHostPermission: hostPermissionGranted })
      : { ok: false as const, error: '' },
  );

  onMount(() => {
    (async () => {
      const [id, secret, currentStatus, granted] = await Promise.all([
        oauthClientId.getValue(),
        oauthClientSecret.getValue(),
        lastRunStatus.getValue(),
        browser.permissions.contains({ origins: [TAILSCALE_ORIGIN] }),
      ]);

      clientId = id;
      clientSecret = secret;
      status = currentStatus;
      hostPermissionGranted = granted;
      loaded = true;
    })();

    // Live updates while a run is in flight, whether it was started from
    // here or from the options page.
    unwatchStatus = lastRunStatus.watch((newValue) => {
      status = newValue;
    });
  });

  onDestroy(() => {
    unwatchStatus?.();
  });

  async function requestManualSync() {
    syncRequestState = 'sending';
    syncRequestError = '';
    const request: ManualSyncRequest = { type: MANUAL_SYNC_MESSAGE_TYPE };
    try {
      const response: unknown = await browser.runtime.sendMessage(request);
      if (isManualSyncResponse(response)) {
        if (response.ok) {
          syncRequestState = 'sent';
        } else {
          syncRequestState = 'error';
          syncRequestError = response.error;
        }
      } else {
        // No listener registered — don't leave the button hanging.
        syncRequestState = 'error';
        syncRequestError = 'Could not reach the background service.';
      }
    } catch (err) {
      // sendMessage rejects outright when there's no receiving end at all
      // (rather than resolving undefined) on some engines/timings.
      syncRequestState = 'error';
      syncRequestError = err instanceof Error ? err.message : 'Could not reach the background service.';
    }
  }

  function openOptions() {
    browser.runtime.openOptionsPage();
  }

  function formatTime(ms: number): string {
    return new Date(ms).toLocaleString();
  }
</script>

<main class="flex w-72 flex-col gap-4 bg-base-100 p-4 text-base-content">
  <header class="flex items-center justify-between gap-2">
    <h1 class="text-lg font-semibold">Tailnet Bookmarks</h1>
    <button type="button" class="btn btn-ghost btn-xs" onclick={openOptions}>Options</button>
  </header>

  {#if loaded && !readiness.ok}
    <div role="alert" class="alert alert-warning text-sm">
      <span>{readiness.error}</span>
    </div>
  {/if}

  <div class="flex flex-col gap-1">
    <span class="text-sm font-medium">Last run</span>
    {#if !loaded}
      <span class="loading loading-spinner loading-xs"></span>
    {:else if status === null}
      <span class="badge badge-neutral w-fit">Never run</span>
    {:else if status.state === 'running'}
      <div class="flex items-center gap-2">
        <span class="loading loading-spinner loading-xs"></span>
        <span class="text-sm">Running since {formatTime(status.startedAt)}</span>
      </div>
    {:else if status.state === 'ok'}
      <div class="flex flex-col gap-1">
        <span class="badge badge-success w-fit">Ok</span>
        <span class="text-xs text-base-content/70">
          {formatTime(status.finishedAt)} — {status.created} created, {status.updated} updated, {status.removed}
          removed
        </span>
      </div>
    {:else if status.state === 'error'}
      <div class="flex flex-col gap-1">
        <span class="badge badge-error w-fit">Error</span>
        <span class="text-xs text-error">{status.message}</span>
        <span class="text-xs text-base-content/70">{formatTime(status.finishedAt)}</span>
      </div>
    {/if}
  </div>

  <div class="flex flex-col gap-2">
    <button
      type="button"
      class="btn btn-primary btn-sm"
      onclick={requestManualSync}
      disabled={!loaded || !readiness.ok || syncRequestState === 'sending'}
    >
      {#if syncRequestState === 'sending'}
        <span class="loading loading-spinner loading-xs"></span>
      {/if}
      Sync now
    </button>

    {#if syncRequestState === 'error'}
      <span class="text-xs text-error">{syncRequestError}</span>
    {/if}
  </div>
</main>
