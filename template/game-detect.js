//Detect Scores: the request to the server and the popup that shows the
//detected scores (reorder, edit digits, score crop, accept). game.js
//includes this file as the mustache partial "game_detect" (route/mnp.js).
//Everything here is private to the function below except what it returns,
//so the only global name it adds is DetectScores. It uses game.js's globals
//(game, scores, sendChanges, setSaveStatus ...) and may use mustache values.
var DetectScores = (function() {

//Shown once the popup is accepted: the scores still need saving.
const SAVE_REMINDER = "Tap the Save button after making any final edits.";
//Score detection: the server may wait up to a minute on the score service.
const DETECT_TIMEOUT_MS = 90000;
//Readings below this confidence get an orange outline for players to check.
const DETECT_CHECK_CONFIDENCE = 0.9;
//Space kept between the detected-scores dialog and the screen edges.
const DIALOG_MARGIN_PX = 16;
//Smallest text a long score in the popup may shrink to, and the step size.
const DETECT_SCORE_MIN_FONT_PX = 12;
const DETECT_SCORE_FONT_STEP_PX = 0.5;
//Edit view: digits are shown in groups of three, and + / − wrap within 0-9.
const DIGITS_PER_GROUP = 3;
//Score crop at the top of the popup: margin around the scores (as a fraction
//of their combined height), and the tallest it may be (fraction of the screen).
const SCORE_CROP_MARGIN = 0.1;
const SCORE_CROP_MAX_SCREEN_HEIGHT = 0.3;
//Tilts smaller than this aren't levelled (the score service's own cutoff).
const MIN_TILT_TO_LEVEL_DEGREES = 0.5;
const DEGREES_PER_HALF_TURN = 180;
const DIGIT_VALUES = 10;

//Detect Scores: save a new or re-framed photo first (the server reads the
//saved photo), then ask the server to read the scores.
function detectScores() {
  var hasPhoto = imageChanged || (game.photos && game.photos.length > 0);
  if(!hasPhoto) {
    setSaveStatus("Choose a photo of the scores first, then press Detect Scores.", true);
    return;
  }
  hideFailure();
  if(imageChanged || posChanged) {
    sendChanges({ detecting: true, onSaved: requestDetection });
  }
  else {
    requestDetection();
  }
}

function requestDetection() {
  $('#detect-cover').show();
  $.ajax({
    url: '/games/{{key}}.{{round}}.{{n}}/detect',
    method: 'POST',
    data: { photo_id: shownPhotoId() },
    dataType: 'json',
    timeout: DETECT_TIMEOUT_MS,
    success: function(result) {
      $('#detect-cover').hide();
      applyDetectedScores(result);
    },
    error: function(xhr, status) {
      $('#detect-cover').hide();
      console.log("... detect failed:", status, xhr.status);
      var reason;
      if(status == 'timeout') {
        reason = "It took too long. Try again.";
      }
      else if(xhr.status == 0) {
        reason = "Could not reach the server. Check your connection.";
      }
      else if(isPlainMessage(xhr.responseText)) {
        reason = xhr.responseText;
      }
      else {
        reason = "Server error " + xhr.status + ".";
      }
      showFailure();
      setSaveStatus("Score detection failed: " + reason, true);
    }
  });
}

//State of the detected-scores popup while it's open. The popup works on its
//own copy of the scores; the page's score fields change only on Accept.
//  count   number of player positions (2 or 4)
//  values  each position's score in the popup (0 = empty)
//  check   whether each value is a low-confidence reading
//  order   positions tapped so far while reordering, or null when not reordering
var detected = null;

//Open the popup with the detected scores. Seats the service couldn't read
//start empty.
function applyDetectedScores(result) {
  var readings = (result && result.scores) || [];
  var count = Math.min(readings.length, scores.length);
  detected = { count: count, values: [], check: [], order: null, picking: false, editing: null, regions: [],
               tilt: (result && typeof result.tiltDegrees == 'number') ? result.tiltDegrees : null };
  var read = 0;
  for(var i = 0; i < count; i++) {
    var s = readings[i];
    detected.values[i] = s ? s.value : 0;
    detected.check[i] = !!s && s.confidence < DETECT_CHECK_CONFIDENCE;
    if(s) read++;
    var corners = s && (s.corners || boundsCorners(s.bounds));
    if(corners) detected.regions.push(corners);
  }
  var message;
  if(read == 0) {
    message = "No scores could be read from this photo. Enter them with the keypad, then use the **Save** button just below the keypad.";
  }
  else {
    //**Name** marks a button name, shown in bold (see setDetectedMessage).
    message = "Verify these scores. If a correct score is assigned to the wrong player, tap **Reorder**, " +
      "then tap all scores in player order. Use **Edit** to make minor changes to a score. Tap ✕ to clear a score. " +
      "Tap **Accept** to apply these scores. Make any final edits using the keypad, then tap **Save**.";
  }
  detected.message = message;
  detected.read = read;
  setSaveStatus("", false);
  $('#detected-credit').text((result && result.poweredBy) || "");
  $('#detected-grid').toggle(read > 0);
  showDetectedMode();
  $('#detected-cover').show();
  drawScoreCrop();
  fitDetectedScores();
  centerDetectedDialog();
  //Focus Accept for keyboard users without scrolling a tall popup away from
  //the score crop at its top.
  $('#accept-btn')[0].focus({ preventScroll: true });
  $('.detected-dialog').scrollTop(0);
}

//Draw the part of the photo holding the detected scores, enlarged to the
//popup's width, so players can compare the readings with the photo. The
//boxes are in the photo's upright pixels, which is also how the browser
//shows it (imgElm is the photo in the preview). If the service measured a
//tilt, the photo is turned level first (rotated by -tilt, as the service
//does) and the crop is taken in that level frame. Hidden if there are no
//boxes or the photo can't be shown (e.g. HEIC outside Safari).
function drawScoreCrop() {
  var canvas = document.getElementById('detected-crop');
  var regions = detected.regions;
  var img = imgElm;
  if(!regions.length || !img || !img.complete || !img.naturalWidth) {
    canvas.style.display = 'none';
    return;
  }
  var tilt = detected.tilt;
  var angle = (tilt !== null && Math.abs(tilt) >= MIN_TILT_TO_LEVEL_DEGREES) ? -tilt * Math.PI / DEGREES_PER_HALF_TURN : 0;
  var cos = Math.cos(angle), sin = Math.sin(angle);
  //Every box corner, turned level (same rotation the canvas applies below).
  var xs = [], ys = [];
  regions.forEach(function(corners) {
    corners.forEach(function(pt) {
      xs.push(pt[0] * cos - pt[1] * sin);
      ys.push(pt[0] * sin + pt[1] * cos);
    });
  });
  //The smallest level rectangle around every score, plus a margin.
  var left = Math.min.apply(null, xs), right = Math.max.apply(null, xs);
  var top = Math.min.apply(null, ys), bottom = Math.max.apply(null, ys);
  var margin = (bottom - top) * SCORE_CROP_MARGIN;
  left -= margin; top -= margin; right += margin; bottom += margin;
  if(angle == 0) {
    //Level photo: keep the crop inside it.
    left = Math.max(0, left); top = Math.max(0, top);
    right = Math.min(img.naturalWidth, right); bottom = Math.min(img.naturalHeight, bottom);
  }
  var cropW = right - left;
  var cropH = bottom - top;
  if(cropW <= 0 || cropH <= 0) {
    canvas.style.display = 'none';
    return;
  }
  //Full popup width, unless that would be taller than the cap.
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  var cssW = canvas.clientWidth;
  var cssH = cssW * cropH / cropW;
  var maxH = window.innerHeight * SCORE_CROP_MAX_SCREEN_HEIGHT;
  if(cssH > maxH) {
    cssW = cssW * maxH / cssH;
    cssH = maxH;
  }
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  //Draw at the screen's pixel density so the digits stay sharp.
  var density = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * density);
  canvas.height = Math.round(cssH * density);
  var ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  //Canvas = scale * (level frame shifted to the crop) * rotation * photo.
  var k = canvas.width / cropW;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.translate(-left, -top);
  ctx.rotate(angle);
  ctx.drawImage(img, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

//The four corners (TL, TR, BR, BL) of an upright box, or null.
function boundsCorners(b) {
  if(!b) return null;
  return [[b.left, b.top], [b.right, b.top], [b.right, b.bottom], [b.left, b.bottom]];
}

//"1, 2" or "1, 2, 3, 4"
function positionList(count) {
  var list = [];
  for(var i = 1; i <= count; i++) list.push(i);
  return list.join(', ');
}

//Set player position i's score field (0 = blank) and mark the scores unsaved.
function setScoreField(i, value, lowConfidence) {
  scores[i] = value;
  var $elm = $('#s'+(i+1));
  $elm.text(value > 0 ? numeral(value).format() : 'Player ' + (i+1) + ' Score');
  fitScoreFields();
  //Back to the saved value: show it as recorded again.
  var saved = game['score_' + (i+1)] || 0;
  $elm.toggleClass('recorded', value > 0 && value == saved);
  $elm.toggleClass('score-check', !!lowConfidence);
  scoreChanged = true;
  $('#save-icon').show();
  updateSaveButton();
}

//Buttons and instructions for normal vs. reordering, then redraw the grid.
//The popup's modes: normal (grid + Reorder/Edit/Reject/Accept), reordering,
//picking a score to edit, and editing one score (shown full width).
function showDetectedMode() {
  var reordering = !!detected.order;
  var picking = !!detected.picking;
  var editing = detected.editing !== null;
  var normal = !reordering && !picking && !editing;
  var hasScores = detected.read > 0;
  var message = detected.message;
  if(reordering) message = "Tap the scores in player order: " + positionList(detected.count) + ".";
  else if(picking) message = "Tap the score to edit.";
  else if(editing) message = "Tap a digit to enable the edit buttons. These allow the selected digit to be deleted, " +
    "decremented, or incremented. Also, you may insert a zero immediately left or right of the selected digit.";
  setDetectedMessage(message);
  $('#detected-message').toggle(!!message);
  $('#accept-btn').toggle(normal);
  //Nothing to discard, reorder or edit if no scores were read.
  $('#reject-btn, #reorder-btn, #edit-btn').toggle(normal && hasScores);
  $('#reorder-reset-btn, #reorder-cancel-btn').toggle(reordering);
  $('#edit-cancel-btn').toggle(picking);
  $('#digit-reset-btn, #digit-undo-btn, #digit-cancel-btn, #digit-accept-btn').toggle(editing);
  $('#detected-grid')
    .toggle(hasScores && !editing)
    .toggleClass('reordering', reordering)
    .toggleClass('picking', picking);
  $('#detected-single').toggle(editing);
  if(editing) {
    renderSingleScore();
  }
  else {
    renderDetectedGrid();
  }
  if(isDetectedOpen()) {
    centerDetectedDialog();
  }
}

//Edit: first pick a score, then it's shown on its own.
function startEditPick() {
  detected.picking = true;
  showDetectedMode();
}

function cancelEditPick() {
  detected.picking = false;
  showDetectedMode();
}

//Editing works on the score's digits as a string (detected.editDigits), so a
//digit can become 0 or be deleted without the number collapsing mid-edit.
//detected.editPos is the selected digit's index, or null. detected.undo is a
//stack of {digits, pos} saved before each change, newest last.
function startEditing(i) {
  detected.picking = false;
  detected.editing = i;
  detected.editDigits = detected.values[i] > 0 ? String(detected.values[i]) : '';
  detected.editOriginal = detected.editDigits;
  detected.editPos = null;
  detected.undo = [];
  showDetectedMode();
}

//Reset: back to the score as it was when this view was opened. It goes on
//the Undo stack like any other change, so an accidental Reset can be undone.
function resetDigits() {
  if(detected.editDigits == detected.editOriginal) return;
  saveForUndo();
  detected.editDigits = detected.editOriginal;
  detected.editPos = null;
  renderSingleScore();
}

//Accept: back to all players, keeping the edited score. Leading zeros are
//dropped, no digits left means an empty slot, and an edited score has been
//checked by a person, so it loses its low-confidence outline.
function acceptEditing() {
  var i = detected.editing;
  var value = detected.editDigits ? parseInt(detected.editDigits, 10) : 0;
  if(value != detected.values[i]) {
    detected.values[i] = value;
    detected.check[i] = false;
  }
  endEditing();
}

//Cancel: back to all players, discarding every change to this score.
function cancelEditing() {
  endEditing();
}

function endEditing() {
  detected.editing = null;
  detected.editPos = null;
  detected.undo = [];
  showDetectedMode();
}

//Remember the digits and selection before a change, for Undo.
function saveForUndo() {
  detected.undo.push({ digits: detected.editDigits, pos: detected.editPos });
}

//Undo: put back the digits and selection from before the latest change.
function undoDigitChange() {
  var last = detected.undo.pop();
  if(!last) return;
  detected.editDigits = last.digits;
  detected.editPos = last.pos;
  renderSingleScore();
}

//One player's name, then a box per digit in groups of three (with the comma
//after each group, kept with it so a wrapped row never starts with a comma),
//then the ✕ / − / + controls for the selected digit.
function renderSingleScore() {
  var i = detected.editing;
  var digits = detected.editDigits;
  $('#detected-single-name').text((i + 1) + ' ' + ($('#p'+(i+1)).text() || 'Player ' + (i+1)));
  var $digits = $('#detected-digits').empty();
  if(!digits) {
    $digits.append($('<span class="digits-empty">').text('—'));
  }
  //The first group takes whatever doesn't divide into threes: 12,345 -> "12" "345".
  var firstGroup = digits.length % DIGITS_PER_GROUP || DIGITS_PER_GROUP;
  var $group = null;
  for(var k = 0; k < digits.length; k++) {
    if(k == 0 || (k - firstGroup) % DIGITS_PER_GROUP == 0) {
      if($group) $group.append($('<span class="digit-sep" aria-hidden="true">').text(','));
      $group = $('<span class="digit-group">').appendTo($digits);
    }
    $('<button type="button" class="digit-box">')
      .text(digits.charAt(k))
      .toggleClass('selected', k === detected.editPos)
      .attr('aria-label', 'Digit ' + (k + 1) + ' of ' + digits.length + ': ' + digits.charAt(k))
      .attr('aria-pressed', k === detected.editPos)
      .on('click', selectDigit.bind(null, k))
      .appendTo($group);
  }
  $('.digit-control').prop('disabled', detected.editPos === null);
  //An empty slot can take its first digit from either insert button.
  $('.digit-insert').prop('disabled', detected.editPos === null && digits.length > 0);
  $('#digit-undo-btn').prop('disabled', detected.undo.length == 0);
  $('#digit-reset-btn').prop('disabled', digits == detected.editOriginal);
}

//+◀ / ▶+: insert a 0 before or after the selected digit (or as the first
//digit of an empty slot) and select it, ready for + / −.
function insertDigit(after) {
  var digits = detected.editDigits;
  var k = detected.editPos;
  if(k === null && digits.length > 0) return;
  saveForUndo();
  var at = k === null ? 0 : (after ? k + 1 : k);
  detected.editDigits = digits.slice(0, at) + '0' + digits.slice(at);
  detected.editPos = at;
  renderSingleScore();
}

function selectDigit(k) {
  detected.editPos = k;
  renderSingleScore();
}

//✕: remove the selected digit; the digit that moves into its place (or the
//new last digit) becomes selected.
function deleteDigit() {
  var k = detected.editPos;
  if(k === null) return;
  saveForUndo();
  var digits = detected.editDigits;
  detected.editDigits = digits.slice(0, k) + digits.slice(k + 1);
  var left = detected.editDigits.length;
  detected.editPos = left == 0 ? null : Math.min(k, left - 1);
  renderSingleScore();
}

//+ / −: change just the selected digit, wrapping 9 -> 0 and 0 -> 9 (no carry).
function bumpDigit(delta) {
  var k = detected.editPos;
  if(k === null) return;
  saveForUndo();
  var digits = detected.editDigits;
  var d = (parseInt(digits.charAt(k), 10) + delta + DIGIT_VALUES) % DIGIT_VALUES;
  detected.editDigits = digits.slice(0, k) + d + digits.slice(k + 1);
  renderSingleScore();
}

//Show the popup text: **Name** in bold (button names), and each ✕ in red
//like the ✕ buttons it refers to.
function setDetectedMessage(text) {
  var $message = $('#detected-message').empty();
  text.split(/(\*\*[^*]+\*\*|✕)/).forEach(function(part) {
    if(part == '✕') {
      $message.append($('<span class="x-mark">').text('✕'));
    }
    else if(part.indexOf('**') == 0) {
      $message.append($('<strong>').text(part.slice(2, -2)));
    }
    else if(part) {
      $message.append(document.createTextNode(part));
    }
  });
}

//A 2 x 2 grid (2 x 1 for singles), laid out like the score fields:
//"1 John Garnett" with the score below it and a ✕ beside the score.
function renderDetectedGrid() {
  var $grid = $('#detected-grid').empty();
  for(var i = 0; i < detected.count; i++) {
    var name = (i + 1) + ' ' + ($('#p'+(i+1)).text() || 'Player ' + (i+1));
    var value = detected.values[i];
    var tapped = detected.order ? detected.order.indexOf(i) : -1;
    var $cell = $('<div class="detected-cell">').attr('data-pos', i);
    if(tapped >= 0) {
      $cell.addClass('tapped').append($('<span class="order-badge">').text(tapped + 1));
    }
    $cell.append($('<div class="detected-name">').text(name));
    var $scoreLine = $('<div class="detected-score-line">')
      .append($('<span class="detected-score">')
        .toggleClass('score-check', !!detected.check[i])
        .text(value > 0 ? numeral(value).format() : '—'));
    //Only a non-empty slot can be cleared.
    if(!detected.order && value > 0) {
      $scoreLine.append($('<button type="button" class="clear-score">')
        .attr('aria-label', 'Clear the detected score for ' + name)
        .text('✕')
        .on('click', clearDetectedScore.bind(null, i)));
    }
    $cell.append($scoreLine);
    if(detected.order) {
      $cell.on('click', tapDetectedCell.bind(null, i));
    }
    else if(detected.picking) {
      $cell.on('click', startEditing.bind(null, i));
    }
    $grid.append($cell);
  }
  fitDetectedScores();
}

//On narrow screens a long score (e.g. 9,999,999,999) may not fit its cell next
//to the ✕. Shrink just that score's text until it fits, rather than cutting
//it off. Only possible once the popup is on screen (hidden elements have no size).
function fitDetectedScores() {
  if(!isDetectedOpen()) return;
  $('#detected-grid .detected-score').each(function() {
    var size = parseFloat(getComputedStyle(this).fontSize);
    while(this.scrollWidth > this.clientWidth && size > DETECT_SCORE_MIN_FONT_PX) {
      size -= DETECT_SCORE_FONT_STEP_PX;
      this.style.fontSize = size + 'px';
    }
  });
}

//✕: empty this slot in the popup. An empty slot leaves the page's field as it is.
function clearDetectedScore(i) {
  detected.values[i] = 0;
  detected.check[i] = false;
  renderDetectedGrid();
}

function startReorder() {
  detected.order = [];
  showDetectedMode();
}

function resetReorder() {
  detected.order = [];
  renderDetectedGrid();
}

function cancelReorder() {
  detected.order = null;
  showDetectedMode();
}

//detected.order[p] is the cell chosen for player p+1, in the order tapped.
//Tapping the most recently numbered cell again un-numbers it, so another
//cell can take that number; other numbered cells ignore taps. Once every
//cell is numbered, move the scores into that order.
function tapDetectedCell(i) {
  if(!detected.order) return;
  var last = detected.order.length - 1;
  if(detected.order[last] === i) {
    detected.order.pop();
    renderDetectedGrid();
    return;
  }
  if(detected.order.indexOf(i) >= 0) return;
  detected.order.push(i);
  if(detected.order.length < detected.count) {
    renderDetectedGrid();
    return;
  }
  var values = [], check = [];
  for(var p = 0; p < detected.count; p++) {
    var from = detected.order[p];
    values[p] = detected.values[from];
    check[p] = detected.check[from];
  }
  detected.values = values;
  detected.check = check;
  detected.order = null;
  showDetectedMode();
}

//Center the dialog on screen; it shows the scores itself, so it may cover them.
function centerDetectedDialog() {
  var $dialog = $('.detected-dialog');
  var top = Math.max(DIALOG_MARGIN_PX, (window.innerHeight - $dialog.outerHeight()) / 2);
  $dialog.css('top', top + 'px');
}

function isDetectedOpen() {
  return $('#detected-cover').is(':visible');
}

//Accept: copy the non-empty slots into their players' score fields; empty
//slots leave those fields as they are. Players still press Save to store
//them, and a toast reminds them.
function acceptDetected() {
  for(var i = 0; i < detected.count; i++) {
    if(detected.values[i] > 0) {
      setScoreField(i, detected.values[i], detected.check[i]);
    }
  }
  //The reminder appears where the bottom of the popup was.
  var popupBottom = $('#detected-cover .detected-dialog')[0].getBoundingClientRect().bottom;
  closeDetected();
  showToast(SAVE_REMINDER, popupBottom);
}

//Reject: discard the detected scores; the page's fields were never changed.
function rejectDetected() {
  closeDetected();
}

function closeDetected() {
  $('#detected-cover').hide();
  detected = null;
}

//Escape backs out of the current step without changes: editing a score (like
//Cancel), choosing one to edit, a reorder, or else closes the popup without
//applying anything (like Cancel).
function escapeDetected() {
  if(detected && detected.editing !== null) cancelEditing();
  else if(detected && detected.picking) cancelEditPick();
  else if(detected && detected.order) cancelReorder();
  else rejectDetected();
}

return {
  detectScores: detectScores,
  acceptDetected: acceptDetected,
  rejectDetected: rejectDetected,
  startReorder: startReorder,
  resetReorder: resetReorder,
  cancelReorder: cancelReorder,
  startEditPick: startEditPick,
  cancelEditPick: cancelEditPick,
  acceptEditing: acceptEditing,
  cancelEditing: cancelEditing,
  undoDigitChange: undoDigitChange,
  resetDigits: resetDigits,
  insertDigit: insertDigit,
  deleteDigit: deleteDigit,
  bumpDigit: bumpDigit,
  isOpen: isDetectedOpen,
  escape: escapeDetected
};
})();
