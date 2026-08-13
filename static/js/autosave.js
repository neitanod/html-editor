/*
 * autosave.js — writes the document to disk a couple of seconds after it
 * changes, so the file on disk is never far behind what is on screen.
 *
 * The timing is a debounce with a ceiling: it waits for the typing to stop,
 * but it never waits longer than MAX_DELAY, because someone writing a long
 * paragraph without pausing is exactly who has the most to lose.
 *
 * Every write goes through HE.save(), so it is the same serialisation, the
 * same pretty printing and the same atomic write as the Save button; the only
 * difference is that it stays quiet unless something fails.
 */
(function (HE) {
  'use strict';

  var IDLE_DELAY = 2000;   /* quiet time after the last change */
  var MAX_DELAY = 10000;   /* ceiling, so continuous typing still reaches disk */
  var RETRY_DELAY = 5000;  /* after a write that failed */

  var timer = null;
  var pendingSince = 0;    /* when the oldest unsaved change arrived */
  var saving = false;

  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function schedule(delay) {
    cancel();
    timer = setTimeout(run, delay);
  }

  /** Idle delay, shortened so the ceiling is respected. */
  function nextDelay() {
    var waited = pendingSince ? Date.now() - pendingSince : 0;
    return Math.max(0, Math.min(IDLE_DELAY, MAX_DELAY - waited));
  }

  function run() {
    timer = null;
    if (saving) { return; } /* the save in flight reschedules itself */
    if (!HE.dirty || HE.readOnly || !HE.ready) { return; }

    // What the source panel holds is a draft until it is applied. Autosaving
    // through HE.save() would apply it behind the user's back, mid-sentence;
    // waiting costs nothing, because applying it marks the document dirty
    // again and brings us right back here.
    if (HE.source && HE.source.isOpen && HE.source.isOpen() &&
        HE.source.hasPendingChanges && HE.source.hasPendingChanges()) {
      schedule(IDLE_DELAY);
      return;
    }

    saving = true;
    HE.save({ silent: true }).then(function (ok) {
      saving = false;
      if (!HE.dirty) { pendingSince = 0; return; }
      // Still dirty: either the user typed while the request travelled, or the
      // write failed. Either way the clock starts again from now.
      pendingSince = Date.now();
      schedule(ok ? IDLE_DELAY : RETRY_DELAY);
    });
  }

  /** Writes right now if there is anything to write. */
  function flush() {
    cancel();
    run();
  }

  HE.on('dirty', function (dirty) {
    if (!dirty) { cancel(); pendingSince = 0; return; }
    if (HE.readOnly) { return; }
    if (!pendingSince) { pendingSince = Date.now(); }
    if (saving) { return; } /* the save in flight will reschedule */
    schedule(nextDelay());
  });

  // Leaving the tab or the window is the moment the two-second wait is worth
  // the least: nobody is going to type the next character anyway.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { flush(); }
  });
  window.addEventListener('blur', flush);

  // Closing the tab does not leave time for a fetch to resolve, so the last
  // version goes out as a beacon, which the browser delivers on its own.
  var beaconedRevision = -1;

  function beacon() {
    if (!HE.dirty || HE.readOnly || !HE.ready || !navigator.sendBeacon) { return; }
    if (beaconedRevision === HE.revision) { return; } /* both events fired */
    beaconedRevision = HE.revision;
    var content = HE.formatHTML ? HE.formatHTML(HE.serialize()) : HE.serialize();
    var payload = new Blob([JSON.stringify({ content: content })], { type: 'application/json' });
    navigator.sendBeacon('/api/document', payload);
  }

  // Both events, because neither covers every way out on its own: beforeunload
  // misses the tab the system discards, pagehide misses nothing but is skipped
  // when the unload is cancelled from the confirmation dialog.
  window.addEventListener('beforeunload', beacon);
  window.addEventListener('pagehide', beacon);

  HE.autosave = {
    flush: flush,
    isPending: function () { return timer !== null || saving; },
    delay: IDLE_DELAY
  };
  HE.modules.autosave = HE.autosave;
})(window.HE);
