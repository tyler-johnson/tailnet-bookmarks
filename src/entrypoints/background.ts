export default defineBackground(() => {
  // Alarm scheduling, settle delay, and run orchestration land in later
  // flights (see DESIGN.md "Approach" and "Components" / background).
  //
  // Nothing may be held in module scope here: Chromium terminates the MV3
  // service worker after roughly 30s idle, and Firefox's event page is
  // unloaded on the same terms. All state goes through `storage`
  // (`storage.sync` for shared config, `storage.local` for the secret and
  // delete-lag state, `storage.session` for the access token) rather than
  // module-level variables.
  browser.alarms.onAlarm.addListener(() => {
    // Reconciliation runs here once the planner/applier/tailscale pieces
    // land (flight #2 onward).
  });
});
