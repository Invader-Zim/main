/*
   Used by template/picking.html and template/responding.html to implement a
   timer on the picking and responding pages so that captains will know how
   long they are taking to choose machines and players.
*/
var referenceTime = 0;

function getElapsedTime() {
   return formatSeconds(Date.now() - referenceTime);
}

function formatSeconds(s) {
   return new Date(s).toISOString().substr(11, 8);
}

function renderElapsedTime(t) {
   if (t !== undefined) {
      referenceTime = t
   }
   $("span.elapsed").text(getElapsedTime());
   setTimeout(function() {
      renderElapsedTime()
   }, 1000);
}
