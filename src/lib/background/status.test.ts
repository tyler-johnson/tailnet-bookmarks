import { describe, expect, it } from 'vitest';
import { badgeForStatus, checkCanStart, deleteLagMsFromPollInterval } from './status';
import type { LastRunStatus } from '../storage';

describe('deleteLagMsFromPollInterval', () => {
  it('uses the configured poll interval, not a hardcoded 30 minutes', () => {
    expect(deleteLagMsFromPollInterval(5)).toBe(5 * 60_000);
    expect(deleteLagMsFromPollInterval(30)).toBe(30 * 60_000);
    expect(deleteLagMsFromPollInterval(120)).toBe(120 * 60_000);
  });
});

describe('checkCanStart', () => {
  it('rejects missing credentials before checking permission', () => {
    const result = checkCanStart({ clientId: '', clientSecret: '', hasHostPermission: true });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('OAuth client id and secret') });
  });

  it('rejects a blank (whitespace-only) secret the same as an empty one', () => {
    const result = checkCanStart({ clientId: 'x', clientSecret: '   ', hasHostPermission: true });
    expect(result.ok).toBe(false);
  });

  it('rejects missing host permission once credentials are present', () => {
    const result = checkCanStart({ clientId: 'x', clientSecret: 'y', hasHostPermission: false });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('permission') });
  });

  it('allows starting when both credentials and permission are present', () => {
    expect(checkCanStart({ clientId: 'x', clientSecret: 'y', hasHostPermission: true })).toEqual({ ok: true });
  });
});

describe('badgeForStatus', () => {
  it('is blank for never-run (null)', () => {
    expect(badgeForStatus(null)).toEqual({ text: '', title: 'Tailnet Bookmarks' });
  });

  it('is blank while running', () => {
    const status: LastRunStatus = { state: 'running', startedAt: 1 };
    expect(badgeForStatus(status).text).toBe('');
  });

  it('is blank on a successful run', () => {
    const status: LastRunStatus = { state: 'ok', startedAt: 1, finishedAt: 2, created: 0, updated: 0, removed: 0 };
    expect(badgeForStatus(status).text).toBe('');
  });

  it('surfaces failure, and only failure, with the error message in the title', () => {
    const status: LastRunStatus = { state: 'error', startedAt: 1, finishedAt: 2, message: 'boom' };
    const badge = badgeForStatus(status);
    expect(badge.text).not.toBe('');
    expect(badge.title).toContain('boom');
  });
});
