// The background run loop's browser wiring. DESIGN.md "Components" /
// background: "Alarm scheduling, settle delay, run orchestration, status
// and badge." Deliberately thin — everything decision-shaped is in
// src/lib/background/run.ts (what a run does), src/lib/planner (what
// ops a run needs), and src/lib/applier (how an op gets carried out).
// This file's only job is wiring those to the real `browser.*` APIs and
// to `storage`.
//
// DESIGN.md "Cross-browser notes" / "The MV3 background differs":
// Chromium terminates the worker after ~30s idle; Firefox's event page
// is unloaded on the same terms. So nothing here is held in module
// scope across runs: `bookmarksAPI` and `tokenStore` below are built
// fresh inside `reconcile()` on every call, not hoisted to module
// scope, and every other piece of state that needs to survive a
// termination (config, the last-run status, the delete-lag map) is read
// from and written straight back to `storage`. The only things actually
// registered at module scope are event listeners, which is required and
// expected under MV3 — they're cheap to re-register every time the
// worker wakes and hold no data of their own. `browser` itself is an
// ambient reference to the extension API, not state.
//
// DESIGN.md "Sync and convergence" / "No event-driven reconcile":
// `bookmarks.onChanged` and `onRemoved` fire for incoming sync changes,
// so reconciling on them would be exactly the feedback loop the whole
// design exists to prevent. Neither is registered anywhere in this
// file. The only triggers are `browser.alarms` (the only clock that
// survives worker termination — `setTimeout` does not) and the manual
// sync message from the options page.

import {
  badgeForStatus,
  checkCanStart,
  deleteLagMsFromPollInterval,
  RECONCILE_ALARM_NAME,
  runReconcile,
  SETTLE_DELAY_MINUTES,
  type RunOutcome,
} from '../lib/background';
import { createSessionTokenStore } from '../lib/tailscale';
import type { BookmarksAPI } from '../lib/applier';
import {
  firstMissingAt as firstMissingAtItem,
  folderParent,
  lastRunStatus,
  oauthClientId,
  oauthClientSecret,
  pollIntervalMinutes,
  sourceDevicesEnabled,
  sourceServicesEnabled,
  TAILSCALE_ORIGIN,
  type LastRunStatus,
} from '../lib/storage';
import { MANUAL_SYNC_MESSAGE_TYPE, type ManualSyncResponse } from './options/messages';

export default defineBackground(() => {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RECONCILE_ALARM_NAME) void reconcile();
  });

  browser.runtime.onMessage.addListener((message) => {
    if (!isManualSyncMessage(message)) return undefined;
    return handleManualSyncMessage();
  });

  // Settle delay gates the first run after startup (DESIGN.md "Sync and
  // convergence" / "Late delivery" — sync changes can land minutes late,
  // and reconciling a half-synced tree is a churn burst by
  // construction). `browser.alarms.create` with the same name replaces
  // any existing alarm, so this only ever (re)establishes the *first*
  // fire's delay; it does not reset an alarm that's already ticking on
  // every worker wake, only on the two events below, which each fire
  // once per real startup or install.
  browser.runtime.onStartup.addListener(() => void scheduleAlarm());
  browser.runtime.onInstalled.addListener(() => void scheduleAlarm());

  // The poll interval is user-configurable (options page,
  // `sync:pollIntervalMinutes`); if it changes while this worker happens
  // to be alive, reschedule the alarm's period to match rather than
  // waiting for the next startup. This does not run a reconcile itself
  // — only the alarm and manual-sync triggers do that.
  pollIntervalMinutes.watch((minutes) => {
    void browser.alarms.create(RECONCILE_ALARM_NAME, { periodInMinutes: minutes, persistAcrossSessions: true });
  });
});

async function scheduleAlarm(): Promise<void> {
  const minutes = await pollIntervalMinutes.getValue();
  await browser.alarms.create(RECONCILE_ALARM_NAME, {
    delayInMinutes: SETTLE_DELAY_MINUTES,
    periodInMinutes: minutes,
    persistAcrossSessions: true,
  });
}

function isManualSyncMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type: unknown }).type === MANUAL_SYNC_MESSAGE_TYPE
  );
}

async function handleManualSyncMessage(): Promise<ManualSyncResponse> {
  const gate = await canStartNow();
  if (!gate.ok) return { ok: false, error: gate.error };

  // Kicked off, not awaited — the manual-sync contract only promises
  // `{ ok: true }` once the request is *accepted*; its outcome is
  // reported through `local:lastRunStatus`, which the options page
  // live-watches (src/entrypoints/options/App.svelte).
  void reconcile();
  return { ok: true };
}

async function canStartNow(): Promise<{ ok: true } | { ok: false; error: string }> {
  const [clientId, clientSecret, hasHostPermission] = await Promise.all([
    oauthClientId.getValue(),
    oauthClientSecret.getValue(),
    browser.permissions.contains({ origins: [TAILSCALE_ORIGIN] }),
  ]);
  return checkCanStart({ clientId, clientSecret, hasHostPermission });
}

/**
 * The full run, alarm- or manual-triggered — both go through the exact
 * same path, per DESIGN.md "Alarm and explicit user action are the only
 * triggers." Reads config fresh from storage, runs the reconcile
 * (src/lib/background/run.ts), persists its result, and updates the
 * badge.
 */
async function reconcile(): Promise<void> {
  const gate = await canStartNow();
  if (!gate.ok) {
    // Can't start at all (DESIGN.md flowchart: "config present? no ->
    // idle, badge 'setup'"). Not a failed *run* — nothing was
    // attempted, so `local:lastRunStatus` is left untouched. The alarm
    // path just idles quietly until configured; the manual path already
    // reported this through its own message response.
    return;
  }

  const startedAt = Date.now();
  await lastRunStatus.setValue({ state: 'running', startedAt });

  // Fresh every call, never hoisted to module scope — see this file's
  // header. `browser.bookmarks` structurally satisfies `BookmarksAPI`
  // already (same seam as tailscale/session-store.ts's `SessionKV`).
  const bookmarksAPI = browser.bookmarks as unknown as BookmarksAPI;
  const tokenStore = createSessionTokenStore();

  try {
    const [clientId, clientSecret, folderParentSymbol, pollMinutes, devicesEnabled, servicesEnabled, storedFirstMissingAt] =
      await Promise.all([
        oauthClientId.getValue(),
        oauthClientSecret.getValue(),
        folderParent.getValue(),
        pollIntervalMinutes.getValue(),
        sourceDevicesEnabled.getValue(),
        sourceServicesEnabled.getValue(),
        firstMissingAtItem.getValue(),
      ]);

    const outcome = await runReconcile({
      credentials: { clientId, clientSecret },
      toggles: { devicesEnabled, servicesEnabled },
      folderParentSymbol,
      firstMissingAt: storedFirstMissingAt,
      now: startedAt,
      deleteLagMs: deleteLagMsFromPollInterval(pollMinutes),
      bookmarks: bookmarksAPI,
      tokenStore,
    });

    await recordOutcome(startedAt, outcome);
  } catch (err) {
    await recordError(startedAt, errorMessage(err));
  }
}

async function recordOutcome(startedAt: number, outcome: RunOutcome): Promise<void> {
  const finishedAt = Date.now();
  let status: LastRunStatus;

  switch (outcome.status) {
    case 'ok':
      await firstMissingAtItem.setValue(outcome.firstMissingAt);
      status = {
        state: 'ok',
        startedAt,
        finishedAt,
        created: outcome.created,
        updated: outcome.updated,
        removed: outcome.removed,
      };
      break;
    case 'aborted':
      // DESIGN.md flowchart: "every slice unknown -> abort, keep
      // folder." `firstMissingAt` is intentionally NOT persisted here —
      // `runReconcile` already returns it unchanged (see run.ts), so
      // writing it back would be a no-op; skipping the write just makes
      // that explicit rather than implying a normal pass happened.
      status = { state: 'error', startedAt, finishedAt, message: outcome.reason };
      break;
    case 'no-parent':
      status = {
        state: 'error',
        startedAt,
        finishedAt,
        message: `folder parent "${outcome.folderParentSymbol}" does not resolve to a bookmark root on this browser`,
      };
      break;
  }

  await lastRunStatus.setValue(status);
  await applyBadge(status);
}

async function recordError(startedAt: number, message: string): Promise<void> {
  const status: LastRunStatus = { state: 'error', startedAt, finishedAt: Date.now(), message };
  await lastRunStatus.setValue(status);
  await applyBadge(status);
}

async function applyBadge(status: LastRunStatus): Promise<void> {
  const badge = badgeForStatus(status);
  await browser.action.setBadgeText({ text: badge.text });
  if (badge.color) await browser.action.setBadgeBackgroundColor({ color: badge.color });
  await browser.action.setTitle({ title: badge.title });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
