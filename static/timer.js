/*
   Live counters in the match timing grids (template/match_head.html), so
   captains can see how long the step in progress is taking: picking,
   responding, and confirming lineups and scores.

   Each <span class="elapsed" data-since="ms"> shows the time since then as
   m:ss, updated every second.
*/
var TIMER_TICK_MS = 1000;
var MS_PER_SECOND = 1000;
var SECONDS_PER_MINUTE = 60;

function formatMinutes(ms) {
   var seconds = Math.max(0, Math.floor(ms / MS_PER_SECOND));
   var s = seconds % SECONDS_PER_MINUTE;
   return Math.floor(seconds / SECONDS_PER_MINUTE) + ":" + (s < 10 ? "0" : "") + s;
}

function renderElapsedTime() {
   $("span.elapsed").each(function() {
      var since = Number($(this).attr("data-since")) || 0;
      $(this).text(formatMinutes(Date.now() - since));
   });
   setTimeout(renderElapsedTime, TIMER_TICK_MS);
}
