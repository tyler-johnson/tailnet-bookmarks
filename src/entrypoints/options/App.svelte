<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '#imports';
  import {
    oauthClientId,
    oauthClientSecret,
    folderParent,
    pollIntervalMinutes,
    sourceDevicesEnabled,
    sourceServicesEnabled,
    lastRunStatus,
    resolveFolderRoots,
    TAILSCALE_ORIGIN,
    DEFAULT_FOLDER_PARENT,
    DEFAULT_POLL_INTERVAL_MINUTES,
    type LastRunStatus,
    type FolderRootSymbol,
  } from '../../lib/storage';
  import { MANUAL_SYNC_MESSAGE_TYPE, isManualSyncResponse, type ManualSyncRequest } from '../../lib/messages';

  // storage.local — this machine only, never synced (DESIGN.md "Auth").
  let clientId = $state('');
  let clientSecret = $state('');
  let authSaveState = $state<'idle' | 'saving' | 'saved'>('idle');

  // storage.sync — shared config, so every machine computes the same
  // desired bookmark set (DESIGN.md "Auth" and "Sync and convergence").
  let folderParentSymbol = $state<FolderRootSymbol>(DEFAULT_FOLDER_PARENT);
  let pollInterval = $state(DEFAULT_POLL_INTERVAL_MINUTES);
  let devicesEnabled = $state(true);
  let servicesEnabled = $state(true);
  let configSaveState = $state<'idle' | 'saving' | 'saved'>('idle');

  // Plain-English fallback labels for the folder-root picker, overwritten
  // per-symbol with this browser's own (localized) root titles once
  // browser.bookmarks.getTree() resolves — see loadFolderRootLabels below.
  // A root that's absent on this engine (e.g. 'menu' on Chromium) or a
  // failed tree read just keeps its fallback label.
  const FALLBACK_FOLDER_ROOT_LABELS: Record<FolderRootSymbol, string> = {
    toolbar: 'Bookmarks Toolbar',
    menu: 'Bookmarks Menu',
    other: 'Other Bookmarks',
  };
  let folderRootLabels = $state<Record<FolderRootSymbol, string>>({
    ...FALLBACK_FOLDER_ROOT_LABELS,
  });

  // Host permission for the Tailscale API. Not assumed granted just because
  // it's in the manifest — Firefox MV3 doesn't re-prompt on an update that
  // adds a host permission (DESIGN.md "Cross-browser notes"), so this page
  // checks and offers to request it.
  let hostPermissionGranted = $state<boolean | null>(null);
  let hostPermissionError = $state('');

  // Manual sync — background doesn't exist yet (flight #6). See the
  // MANUAL_SYNC_MESSAGE_TYPE contract in ./messages.ts.
  let syncRequestState = $state<'idle' | 'sending' | 'sent' | 'error'>('idle');
  let syncRequestError = $state('');

  let status = $state<LastRunStatus | null>(null);
  let loaded = $state(false);

  let unwatchStatus: (() => void) | undefined;
  let authSavedTimeout: ReturnType<typeof setTimeout> | undefined;
  let configSavedTimeout: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    (async () => {
      const [id, secret, parent, interval, devices, services, currentStatus, granted] =
        await Promise.all([
          oauthClientId.getValue(),
          oauthClientSecret.getValue(),
          folderParent.getValue(),
          pollIntervalMinutes.getValue(),
          sourceDevicesEnabled.getValue(),
          sourceServicesEnabled.getValue(),
          lastRunStatus.getValue(),
          browser.permissions.contains({ origins: [TAILSCALE_ORIGIN] }),
        ]);

      clientId = id;
      clientSecret = secret;
      folderParentSymbol = parent;
      pollInterval = interval;
      devicesEnabled = devices;
      servicesEnabled = services;
      status = currentStatus;
      hostPermissionGranted = granted;
      loaded = true;
    })();

    loadFolderRootLabels();

    unwatchStatus = lastRunStatus.watch((newValue) => {
      status = newValue;
    });
  });

  // Reads this browser's real bookmark tree so the picker shows the roots
  // in the user's own words (a German Firefox says "Andere Lesezeichen",
  // not "Other Bookmarks") rather than a hardcoded English guess. Read-only
  // use of resolveFolderRoots — storage still only ever holds the symbol;
  // resolving it at reconcile time is flight #6's job.
  async function loadFolderRootLabels() {
    try {
      const tree = await browser.bookmarks.getTree();
      const resolved = resolveFolderRoots(tree);
      folderRootLabels = {
        toolbar: resolved.toolbar?.title ?? FALLBACK_FOLDER_ROOT_LABELS.toolbar,
        menu: resolved.menu?.title ?? FALLBACK_FOLDER_ROOT_LABELS.menu,
        other: resolved.other?.title ?? FALLBACK_FOLDER_ROOT_LABELS.other,
      };
    } catch {
      // Tree read failed — keep the plain-English fallback labels.
    }
  }

  onDestroy(() => {
    unwatchStatus?.();
    clearTimeout(authSavedTimeout);
    clearTimeout(configSavedTimeout);
  });

  async function saveAuth() {
    authSaveState = 'saving';
    await Promise.all([
      oauthClientId.setValue(clientId.trim()),
      oauthClientSecret.setValue(clientSecret),
    ]);
    authSaveState = 'saved';
    clearTimeout(authSavedTimeout);
    authSavedTimeout = setTimeout(() => (authSaveState = 'idle'), 2000);
  }

  async function saveConfig() {
    configSaveState = 'saving';
    const interval = Math.max(1, Math.round(pollInterval) || DEFAULT_POLL_INTERVAL_MINUTES);
    pollInterval = interval;
    await Promise.all([
      folderParent.setValue(folderParentSymbol),
      pollIntervalMinutes.setValue(interval),
      sourceDevicesEnabled.setValue(devicesEnabled),
      sourceServicesEnabled.setValue(servicesEnabled),
    ]);
    configSaveState = 'saved';
    clearTimeout(configSavedTimeout);
    configSavedTimeout = setTimeout(() => (configSaveState = 'idle'), 2000);
  }

  // Must run synchronously from the click handler's own gesture — Firefox
  // rejects a permissions.request() call that isn't tied to a user action.
  async function grantHostPermission() {
    hostPermissionError = '';
    try {
      const granted = await browser.permissions.request({ origins: [TAILSCALE_ORIGIN] });
      hostPermissionGranted = granted;
      if (!granted) {
        hostPermissionError = 'Permission was not granted.';
      }
    } catch (err) {
      hostPermissionError = err instanceof Error ? err.message : 'Permission request failed.';
    }
  }

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
        // No listener registered yet — background (flight #6) hasn't
        // landed. Don't let the page look broken.
        syncRequestState = 'error';
        syncRequestError = 'Sync is not wired up yet. It will run on the next scheduled poll once it is.';
      }
    } catch (err) {
      syncRequestState = 'error';
      syncRequestError =
        err instanceof Error
          ? err.message
          : 'Could not reach the background service. Sync will run on its next scheduled poll.';
    }
  }

  function formatTime(ms: number): string {
    return new Date(ms).toLocaleString();
  }
</script>

<main class="mx-auto flex max-w-md flex-col gap-8 bg-base-100 p-6 text-base-content">
  <header class="flex flex-col gap-1">
    <h1 class="text-xl font-semibold">Tailnet Bookmarks</h1>
    <p class="text-sm text-base-content/70">
      Mirrors your tailnet's Devices and Services into a bookmarks folder.
    </p>
  </header>

  {#if hostPermissionGranted === false}
    <div class="alert alert-warning flex flex-col items-start gap-2">
      <span>Access to the Tailscale API has not been granted yet. Sync cannot run without it.</span>
      <button type="button" class="btn btn-sm btn-primary" onclick={grantHostPermission}>
        Grant access to api.tailscale.com
      </button>
      {#if hostPermissionError}
        <span class="text-xs text-error">{hostPermissionError}</span>
      {/if}
    </div>
  {/if}

  <section class="flex flex-col gap-4">
    <div class="flex flex-col gap-1">
      <h2 class="text-lg font-medium">Authentication</h2>
      <p class="text-xs text-base-content/70">
        A Tailscale OAuth client (client credentials grant). Stored on this machine only and
        never synced.
      </p>
    </div>

    <details class="collapse collapse-arrow bg-base-200">
      <summary class="collapse-title text-sm font-medium">Required Scopes</summary>
      <div class="collapse-content flex flex-col gap-3">
        <ul class="flex flex-col gap-2">
          <li class="flex flex-wrap items-center gap-2">
            <span class="text-xs">
              General <span class="text-base-content/50">&rsaquo;</span>
              <span class="font-medium">Services</span>
            </span>
            <span class="badge badge-sm badge-primary badge-soft">Read</span>
          </li>
          <li class="flex flex-wrap items-center gap-2">
            <span class="text-xs">
              Devices <span class="text-base-content/50">&rsaquo;</span>
              <span class="font-medium">Core</span>
            </span>
            <span class="badge badge-sm badge-primary badge-soft">Read</span>
          </li>
        </ul>
        <span class="text-xs text-base-content/70">
          In the Tailscale admin console, go to Settings &rarr; Trust Credentials and create
          an OAuth client with exactly these two scopes. Nothing else needs checking &mdash;
          this extension only reads, and never changes anything on your tailnet. A client
          missing either scope still saves here, then fails later with a permission error
          when it tries to read.
        </span>
      </div>
    </details>

    <label class="flex w-full flex-col gap-2">
      <span class="text-sm font-medium">OAuth client ID</span>
      <input type="text" class="input w-full" autocomplete="off" bind:value={clientId} />
      <span class="text-xs text-base-content/70">From the Tailscale admin console.</span>
    </label>

    <label class="flex w-full flex-col gap-2">
      <span class="text-sm font-medium">OAuth client secret</span>
      <input type="password" class="input w-full" autocomplete="off" bind:value={clientSecret} />
      <span class="text-xs text-base-content/70">
        Never leaves this machine — held in local storage, not synced.
      </span>
    </label>

    <div class="flex items-center gap-3">
      <button type="button" class="btn btn-primary" onclick={saveAuth} disabled={!loaded}>
        Save
      </button>
      {#if authSaveState === 'saved'}
        <span class="badge badge-success">Saved</span>
      {/if}
    </div>
  </section>

  <div class="divider"></div>

  <section class="flex flex-col gap-4">
    <div class="flex flex-col gap-1">
      <h2 class="text-lg font-medium">Sync settings</h2>
      <p class="text-xs text-base-content/70">
        Shared across every machine on your browser account, so they all compute the same
        bookmarks.
      </p>
    </div>

    <label class="flex w-full flex-col gap-2">
      <span class="text-sm font-medium">Folder location</span>
      <select class="select w-full" bind:value={folderParentSymbol}>
        <option value="toolbar">{folderRootLabels.toolbar}</option>
        <option value="menu">{folderRootLabels.menu}</option>
        <option value="other">{folderRootLabels.other}</option>
      </select>
      <span class="text-xs text-base-content/70">
        Where the tailnet folder lives. The same choice on every machine, computed locally on
        each — not a shared folder id.
      </span>
    </label>

    <label class="flex w-full flex-col gap-2">
      <span class="text-sm font-medium">Poll interval (minutes)</span>
      <input type="number" class="input w-full" min="1" step="1" bind:value={pollInterval} />
      <span class="text-xs text-base-content/70">How often to check for changes.</span>
    </label>

    <div class="flex flex-col gap-3">
      <span class="text-sm font-medium">Sources</span>

      <label class="flex items-center gap-3">
        <input type="checkbox" class="toggle toggle-primary" bind:checked={devicesEnabled} />
        <span class="text-sm">Devices</span>
      </label>

      <label class="flex items-center gap-3">
        <input type="checkbox" class="toggle toggle-primary" bind:checked={servicesEnabled} />
        <span class="text-sm">Services</span>
      </label>
    </div>

    <div class="flex items-center gap-3">
      <button type="button" class="btn btn-primary" onclick={saveConfig} disabled={!loaded}>
        Save
      </button>
      {#if configSaveState === 'saved'}
        <span class="badge badge-success">Saved</span>
      {/if}
    </div>
  </section>

  <div class="divider"></div>

  <section class="flex flex-col gap-4">
    <div class="flex flex-col gap-1">
      <h2 class="text-lg font-medium">Manual sync</h2>
      <p class="text-xs text-base-content/70">Trigger a reconcile now instead of waiting for the next poll.</p>
    </div>

    <div class="flex items-center gap-3">
      <button
        type="button"
        class="btn btn-secondary"
        onclick={requestManualSync}
        disabled={syncRequestState === 'sending'}
      >
        {#if syncRequestState === 'sending'}
          <span class="loading loading-spinner loading-sm"></span>
        {/if}
        Sync now
      </button>
    </div>

    {#if syncRequestState === 'error'}
      <span class="text-xs text-error">{syncRequestError}</span>
    {/if}

    <div class="flex flex-col gap-1">
      <span class="text-sm font-medium">Last run</span>
      {#if status === null}
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
  </section>
</main>
