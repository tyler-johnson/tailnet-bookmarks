// Module surface for the `background` component (DESIGN.md "Components").
// Consumed by src/entrypoints/background.ts, the thin wrapper that wires
// these to `browser.alarms`, `browser.runtime`, `browser.permissions`,
// and `storage`.

export { runReconcile } from './run';
export type { RunInputs, RunOutcome } from './run';

export {
  RECONCILE_ALARM_NAME,
  SETTLE_DELAY_MINUTES,
  deleteLagMsFromPollInterval,
  checkCanStart,
  badgeForStatus,
} from './status';
export type { Badge } from './status';
