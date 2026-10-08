/*
   Timers on the match pages, so that captains will know how long they are
   taking: choosing machines and players (template/picking.html and
   template/responding.html), and confirming lineups and scores (the timing
   grid in template/match_head.html, on the pregame and playing pages).

   Each <span class="elapsed"> counts up from its data-since time (ms), or from
   referenceTime if it has none. It shows hh:mm:ss, or m:ss with
   data-format="m:ss".
*/
var TIMER_TICK_MS = 1000;
var MS_PER_SECOND = 1000;
var SECONDS_PER_MINUTE = 60;
var FORMAT_MINUTES = "m:ss";
var referenceTime = 0;

function getElapsedTime(since) {
   return formatSeconds(Date.now() - (since || referenceTime));
}

function formatSeconds(s) {
   return new Date(s).toISOString().substr(11, 8);
}

function formatMinutes(ms) {
   var seconds = Math.floor(ms / MS_PER_SECOND);
   var s = seconds % SECONDS_PER_MINUTE;
   return Math.floor(seconds / SECONDS_PER_MINUTE) + ":" + (s < 10 ? "0" : "") + s;
}

function renderElapsedTime(t) {
   if (t !== undefined) {
      referenceTime = t
   }
   $("span.elapsed").each(function() {
      var since = Number($(this).attr("data-since")) || 0;
      if ($(this).attr("data-format") == FORMAT_MINUTES) {
         $(this).text(formatMinutes(Date.now() - (since || referenceTime)));
      }
      else {
         $(this).text(getElapsedTime(since));
      }
   });
   setTimeout(function() {
      renderElapsedTime()
   }, TIMER_TICK_MS);
}
