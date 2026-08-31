// Module surface for the desired-set component (flight #3). Consumed
// directly by the planner (flight #4): `buildDesiredSet` is the only
// entry point, and its return type is what `plan(desired, actual)`
// takes as `desired`.

export { buildDesiredSet } from './desired-set';
export type { BookmarkSource, DesiredBookmark, DesiredSet, SliceOutcome, SourceToggles } from './desired-set';
