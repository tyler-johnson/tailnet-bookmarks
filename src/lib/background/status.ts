// Small pure pieces of the background run loop's orchestration —
// factored out of src/entrypoints/background.ts so they're testable
// without a browser/WXT runtime, the same reasoning as run.ts.

import type { LastRunStatus } from '../storage';

/** Alarm name for the recurring reconcile. A named alarm is required to
 * both reschedule it (creating another alarm of the same name replaces
 * it — see `scheduleAlarm` in background.ts) and to tell it apart from
 * any other alarm this or a future flight might register. */
export const RECONCILE_ALARM_NAME = 'tailnet-bookmarks:reconcile';

/**
 * How long after browser startup the first reconcile waits before
 * running. DESIGN.md "Sync and convergence" / "Late delivery": "Sync
 * changes can land minutes after a browser starts. Reconciling against a
 * half-synced tree produces a churn burst by construction." DESIGN.md
 * "Open questions" books the exact value as an open guess pending real
 * churn data from two live machines — same as the poll interval's 30m
 * default, which is also a stated guess. Two minutes is chosen as a
 * plausible reading of "minutes late," not a measured value.
 */
export const SETTLE_DELAY_MINUTES = 2;

/**
 * DESIGN.md "Lagged deletes": a removal needs the URL absent "on two
 * consecutive polls at least one interval apart." The configured poll
 * interval itself is the minimum value that satisfies "at least one" —
 * anything smaller would let the same disagreement that started a poll
 * ago still be live when the second look happens, which is exactly the
 * flap this rule exists to absorb. Never hardcoded (DESIGN.md's default
 * of 30m is only ever a *default* for the configurable interval, not a
 * constant this reads).
 */
export function deleteLagMsFromPollInterval(pollIntervalMinutes: number): number {
  return pollIntervalMinutes * 60_000;
}

/** Whether a run can even start, and why not if it can't. Checked before
 * a "running" status is ever written — DESIGN.md's manual-sync contract
 * (see src/lib/messages) has background "respond { ok: false, error } if
 * it can't start (e.g. missing config or missing host permission)"
 * without implying a run was attempted at all. */
export function checkCanStart(input: {
  clientId: string;
  clientSecret: string;
  hasHostPermission: boolean;
}): { ok: true } | { ok: false; error: string } {
  if (!input.clientId.trim() || !input.clientSecret.trim()) {
    return { ok: false, error: 'OAuth client id and secret are not set — configure them on the options page.' };
  }
  if (!input.hasHostPermission) {
    return {
      ok: false,
      error: 'Missing permission to reach api.tailscale.com — grant it on the options page.',
    };
  }
  return { ok: true };
}

export interface Badge {
  text: string;
  /** CSS color string; omitted when `text` is empty since it has
   * nothing to color. */
  color?: string;
  title: string;
}

/**
 * DESIGN.md "Components" / background: "status and badge." The badge's
 * only job is surfacing *failure* — a quiet, healthy extension stays
 * visually silent, so `null` (never run), `running`, and `ok` all clear
 * it. Only `error` shows anything: a background reconcile failing
 * without a chrome:// URL to check is otherwise invisible. Never
 * reconciled reads as "not configured yet" rather than an error — see
 * `checkCanStart` above; the badge for that state is likewise blank
 * because failing before a first attempt isn't a *failed run*.
 */
export function badgeForStatus(status: LastRunStatus | null): Badge {
  if (status?.state === 'error') {
    return { text: '!', color: '#dc2626', title: `Tailnet Bookmarks: last sync failed — ${status.message}` };
  }
  return { text: '', title: 'Tailnet Bookmarks' };
}
