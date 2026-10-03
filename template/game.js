var labels = {{&labels}};
var game = {{&game}};
var machines = {{&machines}};
var left_players = {{&left_players}};
var right_players = {{&right_players}};
var curScore = -1;
var scores = [0,0,0,0];
var photoBlob;   //photo bytes to upload (a File or Blob), set when a new photo is chosen
var imageUrl;    //what the preview shows: an object URL for a new photo, or /pics/<sha>
var imageRot = 0;
var imageChanged = false;
var posChanged = false;
var scoreChanged = false;
//Rotating is a deliberate edit, unlike pinch/pan which people use just to read the photo.
var rotationChanged = false;

var adjustScale = 1;
var adjustDeltaX = 0;
var adjustDeltaY = 0;

const SAVE_TIMEOUT_MS = 60000;
const HTTP_CLIENT_ERROR = 400;
const HTTP_SERVER_ERROR = 500;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_CONFLICT = 409;
//How long the checkmark stays solid before it starts to grow and fade.
const SUCCESS_HOLD_MS = 1000;
//Must match the .success-begin transition time in game.css.
const SUCCESS_ANIMATION_MS = 2000;
const SUCCESS_HIDE_DELAY_MS = 10;
//Saves faster than this hold the full progress bar so people can see it.
const FAST_SAVE_MS = 1000;
const FULL_BAR_HOLD_MS = 500;
//A scores-only save shows the saving box only if it takes longer than this.
const SLOW_SAVE_SHOW_MS = 300;
//How long the red X stays up after a failed save.
const FAILURE_SHOW_MS = 3000;
//How long a toast message stays up.
const TOAST_SHOW_MS = 2000;
//A placed toast sits this far inside the bottom edge it's given, and stays
//at least this far from the screen edges.
const TOAST_EDGE_PX = 12;
const SCORE_FIELDS = ['score_1', 'score_2', 'score_3', 'score_4'];
const KEY_ESCAPE = 27;
//Photo preview zoom: 1 fits the whole photo; pinching can zoom in but not below this.
const MIN_PHOTO_ZOOM = 1;
//Panning may leave up to this fraction of the preview empty across (and, at
//the same time, down), so a corner of the photo can be framed to leave out
//numbers that aren't scores.
const MAX_PREVIEW_EMPTY = 0.5;
//Photo preview canvas size.
const PREVIEW_WIDTH = 300;
const PREVIEW_HEIGHT = 188;
//Score fields: smallest text a long score may shrink to, and the step size.
const SCORE_FIELD_MIN_FONT_PX = 11;
const SCORE_FIELD_FONT_STEP_PX = 0.5;
//Room left beside the text, so a fraction of a pixel never triggers the ellipsis.
const SCORE_FIELD_FIT_MARGIN_PX = 2;
var failureTimer = null;
var toastTimer = null;

//options (optional): { detecting: true, onSaved: fn } when Detect Scores saves
//a new photo first; onSaved runs after a successful save (or right away if
//there's nothing to save).
function sendChanges(options) {
  console.log("sendChanges() ...");
  options = options || {};
  var data = {};

  $('.edit').hide();
  $('.norm').show();

  var dirty = false;

  if(posChanged) {
console.log("posChanged:",posChanged);
    data.photo_rotation = imageRot;
    data.photo_scale    = adjustScale;
    data.photo_dx       = adjustDeltaX;
    data.photo_dy       = adjustDeltaY;
    //Framing for the saved photo: say which photo, so the server can refuse
    //if someone else has saved a newer one since this page loaded.
    if(!imageChanged && shownPhotoId()) {
      data.photo_id = shownPhotoId();
    }
    dirty = true;
  }

  if(scoreChanged) {
console.log("scoreChanged:",scoreChanged);
    data.score_1 = scores[0];
    data.score_2 = scores[1];
    data.score_3 = scores[2];
    data.score_4 = scores[3];
    dirty = true;
  }
  console.log(data);

  if(imageChanged) {
    console.log("++ photo bytes:", photoBlob.size);
    data.photo = photoBlob;
    dirty = true;
  }

  var info = getInfoChanges();
  if(info) {
console.log("infoChanged -> ",info);
    for(prop in info) {
      data[prop] = info[prop];
    }
    dirty = true;
  }

  if(curScore != -1) {
    $('#s'+(curScore+1)).removeClass('highlight');
    curScore = -1;
  }
  if(dirty) {
    sendData(data, options);
  }
  else if(options.onSaved) {
    options.onSaved();
  }
  else {
    console.log("Nothing to change, consider tying enabled state of save to dirty.");
    setSaveStatus("No changes to save.", false);
  }
}

function setSaveStatus(msg, isError) {
  var $status = $('#save-status');
  $status.text(msg).toggleClass('save-error', isError);
  if(msg) {
    //Only scrolls if the message is off screen, and only as far as needed.
    $status[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

//True for a short text message from our routes, false for an HTML error page.
function isPlainMessage(text) {
  return !!text && text.trim().charAt(0) != '<';
}

function saveFailed(reason, hint) {
  $('.modal-cover').hide();
  $('#progress').css('width','0%');
  showFailure();
  if(hint === undefined) {
    hint = "Your changes are still here. Press Save to try again.";
  }
  setSaveStatus("Save failed: " + reason + (hint ? " " + hint : ""), true);
}

//Red X in the same spot as the saving box and success checkmark.
function showFailure() {
  clearTimeout(failureTimer);
  $('#failure').show();
  failureTimer = setTimeout(hideFailure, FAILURE_SHOW_MS);
}

function hideFailure() {
  clearTimeout(failureTimer);
  $('#failure').hide();
}

//A short message that fades away by itself. bottomY (optional, in screen
//pixels) puts the toast's bottom edge just above that height, e.g. where a
//popup that just closed ended; otherwise it sits near the bottom of the screen.
function showToast(msg, bottomY) {
  clearTimeout(toastTimer);
  var $toast = $('#toast').text(msg);
  if(bottomY === undefined) {
    $toast.css({ top: '', bottom: '' });
  }
  else {
    var top = bottomY - TOAST_EDGE_PX - $toast.outerHeight();
    var maxTop = window.innerHeight - TOAST_EDGE_PX - $toast.outerHeight();
    $toast.css({ top: Math.max(TOAST_EDGE_PX, Math.min(top, maxTop)) + 'px', bottom: 'auto' });
  }
  $toast.addClass('toast-show');
  toastTimer = setTimeout(function() {
    $('#toast').removeClass('toast-show');
  }, TOAST_SHOW_MS);
}

function sendData(data, options) {
  if(!data) return;
  console.log("sendData...");
  options = options || {};
  var sentPhoto = !!data.photo;
  var sentScores = SCORE_FIELDS.some(function(field) { return field in data; });
  //Multipart, so the photo goes up as raw bytes (see middleware/photo-upload.js).
  var form = new FormData();
  for(var field in data) {
    if(field == 'photo') {
      form.append('photo', data.photo, PhotoUpload.photoFilename(data.photo));
    }
    else {
      form.append(field, data[field]);
    }
  }
  var startTime = Date.now();
  hideFailure();
  setSaveStatus("", false);
  $('#progress').css('width','0%');
  //The saving box and progress bar are for photo uploads. A scores-only save
  //is usually instant, so its box only appears if it's still going after
  //SLOW_SAVE_SHOW_MS (e.g. on a slow connection).
  var coverTimer = null;
  $.ajax({
    xhr: function() {
      var x = new XMLHttpRequest();
      if(sentPhoto) {
        $('#save-cover').show();
      }
      else {
        coverTimer = setTimeout(function() { $('#save-cover').show(); }, SLOW_SAVE_SHOW_MS);
      }
      if(x.upload) {
        x.upload.onprogress = function(e) {
          console.log("prog:",e);
          if(e.lengthComputable) {
            var pct = 100 * e.loaded / e.total;
            $('#progress').css('width',pct+'%');
          }
        }
      }
      return x;
    },
    url: '/games/{{key}}.{{round}}.{{n}}/report',
    data: form,
    processData: false,
    contentType: false,
    method: 'POST',
    timeout: SAVE_TIMEOUT_MS,
    success: function(result) {
      clearTimeout(coverTimer);
      //The server reports some errors as a 200 with a text message
      //instead of the game object.
      if(!result || typeof result !== 'object') {
        console.log("... send rejected:", result);
        saveFailed(typeof result === 'string' && result ? result : "The server did not accept the save.");
        return;
      }
      console.log("... send successful");
      console.log(result);
      fillProgressBar(startTime, function() {
        $('.modal-cover').hide();

        //The photo we just uploaded is already on screen; don't download it again.
        if(sentPhoto && result.photos && result.photos.length > 0) {
          curImageUrl = result.photos[0].url;
        }
        game = result;
        setValues();
        //When Detect Scores only uploaded the photo, skip the checkmark: no scores were saved.
        if(!options.detecting || sentScores) {
          showSuccess();
        }
        var time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        setSaveStatus("✓ Saved at " + time + (sentPhoto ? " (photo uploaded)" : ""), false);
        if(options.onSaved) {
          options.onSaved();
        }
      });
    },
    error: function(xhr, status, err) {
      clearTimeout(coverTimer);
      console.log("... send failed:", status, err);
      if(status == 'timeout') {
        saveFailed("The upload timed out.");
      }
      else if(xhr.status == 0) {
        saveFailed("Could not reach the server. Check your connection.");
      }
      else if(xhr.status == HTTP_PAYLOAD_TOO_LARGE) {
        saveFailed("The photo is too large to upload.", "Choose a smaller photo, then press Save.");
      }
      else if(xhr.status == HTTP_CONFLICT && isPlainMessage(xhr.responseText)) {
        //A newer photo was saved elsewhere; trying again won't help, so no retry hint.
        saveFailed(xhr.responseText, "");
      }
      else if(xhr.status >= HTTP_CLIENT_ERROR && xhr.status < HTTP_SERVER_ERROR && isPlainMessage(xhr.responseText)) {
        saveFailed(xhr.responseText);
      }
      else {
        saveFailed("Server error " + xhr.status + ".");
      }
    }
  });
}

//Show the progress bar full before the saving box closes. The last upload
//progress update and the server's reply can land in the same screen refresh,
//so without this the full bar is never drawn.
function fillProgressBar(startTime, done) {
  //Nothing to fill if the saving box never appeared (a quick scores-only save).
  if(!$('#save-cover').is(':visible')) {
    return done();
  }
  $('#progress').css('width','100%');
  var holdMs = (Date.now() - startTime < FAST_SAVE_MS) ? FULL_BAR_HOLD_MS : 0;
  //Two frames: the first schedules the paint, the second runs after it.
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      setTimeout(done, holdMs);
    });
  });
}

function showSuccess() {
  var $elm = $('#success');
  $elm.show();
  //Hold the checkmark solid, then start the transition. The delay also
  //lets the transition trigger instead of jumping to the end style.
  setTimeout(function() {
    $elm.addClass('success-end');
    setTimeout(function() {
      $elm.removeClass('success-end');
      $elm.hide();
      $('#progress').css('width','0%');
    }, SUCCESS_ANIMATION_MS + SUCCESS_HIDE_DELAY_MS);
  }, SUCCESS_HOLD_MS);
  console.log(Date.now(),"end of showSuccess");
}

function getInfoChanges() {
  var $m = $('#machine');

  //Gather up the data to send.
  var data = {
    machine: $('#machine').val(),
    player_1: $('#player_1').val(),
    player_2: $('#player_2').val()
  }
  var orig = {
    machine: game.machine,
    player_1: game.player_1,
    player_2: game.player_2
  }
  {{#doubles}}
  data.player_3 = $('#player_3').val();
  data.player_4 = $('#player_4').val();
  orig.player_3 = game.player_3,
  orig.player_4 = game.player_4
  {{/doubles}}
  // console.log("data:",data);

  if(JSON.stringify(orig) == JSON.stringify(data)) {
    console.log("stringify: orig == data, bailing out.");
    //We don't need to do anything.
    return;
  }
  return data;
}

var curImageUrl;

//The sha of the saved photo on screen (from /pics/<sha>), or null.
function shownPhotoId() {
  return (curImageUrl && curImageUrl.indexOf('/pics/') == 0) ? curImageUrl.split('/').pop() : null;
}

function loadThumb(url) {
  if(curImageUrl == url) {
    console.log("Already loaded " +url);
    return;
  }
  curImageUrl = url;
console.log("Trying to load thumb: " +url);
  //The server sends the image bytes with the right Content-Type (older
  //base64 uploads are decoded there), so the browser can load it directly.
  setImageUrl(url);
}

var currentScale = 1;
var currentDeltaX = 0;
var currentDeltaY = 0;

/**
Some pan and zoom code found here:
https://gist.github.com/synthecypher/f778e4f5a559268a874e
NOTE: This found code doesn't work very well for our
purposes. Need to change to make more sense for the user.
*/

function setupImageController() {
  var frame = document.getElementById('canvas');
  var mc = new Hammer.Manager(frame);
  var pinch = new Hammer.Pinch();
  var pan = new Hammer.Pan();
  var doubleTap = new Hammer.Tap({ event: 'doubletap', taps: 2 });
  pinch.recognizeWith(pan);
  mc.add([pinch,pan,doubleTap]);

  //Double-tapping anywhere in the preview puts the photo back the way a new
  //photo starts: zoom 1, fitted to the preview.
  mc.on("doubletap", function (ev) {
    if(!imgElm || !imgElm.naturalWidth) return;
    resetFraming();
  });

  //A point of the photo (in photo pixels, in the rotated frame) lands on the
  //preview at zoom * (delta + point), where zoom = fit * scale. When a gesture
  //starts, remember which photo point is under the fingers; every move then
  //puts that point back under the fingers. So a pan follows the finger
  //exactly and a pinch zooms about the point between the fingers.
  var anchor = null;

  //pan and pinch can both start during one gesture; anchor once, from the
  //framing before the gesture and where the fingers first touched.
  mc.on("panstart pinchstart", function (ev) {
    if(anchor || !imgElm || !imgElm.naturalWidth) return;
    var zoom = previewLayout().fit * adjustScale;
    var start = canvasPoint(ev.center.x - ev.deltaX, ev.center.y - ev.deltaY);
    anchor = { x: start.x / zoom - adjustDeltaX, y: start.y / zoom - adjustDeltaY };
  });

  mc.on("pinch pan", function (ev) {
    if(!anchor) return;
    //Zoom in only: 1 is the whole photo fitted to the preview, and smaller just
    //leaves empty space around it.
    currentScale = Math.max(MIN_PHOTO_ZOOM, adjustScale * ev.scale);
    var zoom = previewLayout().fit * currentScale;
    var fingers = canvasPoint(ev.center.x, ev.center.y);
    currentDeltaX = fingers.x / zoom - anchor.x;
    currentDeltaY = fingers.y / zoom - anchor.y;
    clampPan();
    posChanged = true;
    drawImage();
  });

  //Saving the final transforms for adjustment next time the user interacts.
  function saveFraming() {
    adjustScale = currentScale;
    adjustDeltaX = currentDeltaX;
    adjustDeltaY = currentDeltaY;
  }

  //A pinch ends as soon as one finger lifts, which may be before the other
  //finger does, so this keeps the anchor for a pan that carries on.
  mc.on("panend pinchend pancancel pinchcancel", function (ev) {
    saveFraming();
    $('#save-icon').show();
  });

  //The gesture is over only when the last finger lifts. Hammer reports that on
  //its raw input (whether or not a pan or pinch was running), so end it there.
  mc.on("hammer.input", function (ev) {
    if(ev.isFinal && anchor) {
      saveFraming();
      anchor = null;
    }
  });
}

//Back to the framing a newly chosen photo gets: zoom 1, covering the preview
//(or centered where the photo is too small to). The rotation is kept.
function resetFraming() {
  currentScale = MIN_PHOTO_ZOOM;
  currentDeltaX = 0;
  currentDeltaY = 0;
  clampPan(true);
  adjustScale = currentScale;
  adjustDeltaX = currentDeltaX;
  adjustDeltaY = currentDeltaY;
  posChanged = true;
  $('#save-icon').show();
  drawImage();
}

//A screen point (clientX/Y) in the preview canvas's own pixels.
function canvasPoint(x, y) {
  var canvas = document.getElementById('canvas');
  var rect = canvas.getBoundingClientRect();
  var k = canvas.width / rect.width;
  return { x: (x - rect.left) * k, y: (y - rect.top) * k };
}

function setImageUrl(url) {
console.log("setImageUrl()...", url);
  //Free the previous new-photo object URL once it's no longer shown.
  if(imageUrl && imageUrl != url && imageUrl.indexOf('blob:') == 0) {
    URL.revokeObjectURL(imageUrl);
  }
  imageUrl = url;
  renderImage();
  $('#canvas').show();
  $('#cell-left').show();
  $('#cell-right').show();
}

var imgElm;
var fitNewPhoto = false;   //set when a new photo is chosen, until it has loaded

function setupImage() {
  imgElm = document.createElement('img');
  imgElm.onload = function() {
    //A newly chosen photo starts positioned to cover the preview (or centered
    //where it's too small to); a saved photo keeps its stored framing.
    if(fitNewPhoto) {
      fitNewPhoto = false;
      clampPan(true);
      //Save this framing with the photo, so a reload and score detection see
      //the same view as the player.
      if(currentDeltaX != adjustDeltaX || currentDeltaY != adjustDeltaY) {
        posChanged = true;
      }
      adjustDeltaX = currentDeltaX;
      adjustDeltaY = currentDeltaY;
    }
    drawImage();
  };
  imgElm.onerror = function() {
    console.log("Couldn't display photo: " + imgElm.src);
  };
}

function renderImage() {
  if(!imgElm) setupImage();
  imgElm.src = imageUrl;
}

//How the photo sits in the preview before zoom and pan: its size once rotated
//(width, height, in photo pixels) and the scale that fits it (fit).
function previewLayout() {
  var ang = (imageRot + 360) % 360;
  var w = imgElm.width;
  var h = imgElm.height;
  var flip = (ang == 90 || ang == 270);
  var scale;
  if(flip) {
    scale = (w > h) ? PREVIEW_HEIGHT / w : PREVIEW_WIDTH / h;
  }
  else {
    scale = (w > h) ? PREVIEW_WIDTH / w : PREVIEW_HEIGHT / h;
  }
  return { angle: ang, width: flip ? h : w, height: flip ? w : h, fit: scale };
}

//Keep the photo mostly in the preview: its left/top edge lands at
//zoom * delta and its right/bottom edge at zoom * (delta + size), so each
//delta is limited to leave at most MAX_PREVIEW_EMPTY of the preview empty on
//either side. With fit set (a new or rotated photo), the photo covers the
//preview instead, or is centered where it is narrower (or shorter).
function clampPan(fit) {
  if(!imgElm || !imgElm.naturalWidth) return;
  var layout = previewLayout();
  var zoom = layout.fit * currentScale;
  var empty = fit ? 0 : MAX_PREVIEW_EMPTY;
  currentDeltaX = clampAxis(currentDeltaX, PREVIEW_WIDTH / zoom, layout.width, empty);
  currentDeltaY = clampAxis(currentDeltaY, PREVIEW_HEIGHT / zoom, layout.height, empty);
}

//delta limited to [view - gap - size, gap] (view and size in photo pixels;
//gap is emptyFraction of the view, the most left uncovered on one side), or
//centered when that range is empty.
function clampAxis(delta, view, size, emptyFraction) {
  var gap = view * emptyFraction;
  var low = view - gap - size;
  if(low >= gap) return (view - size) / 2;
  return Math.min(gap, Math.max(low, delta));
}

function drawImage() {
  var img = imgElm;
  //Nothing to draw until the photo has loaded, or if this browser can't
  //display its format (e.g. HEIC outside Safari).
  if(!img || !img.complete || !img.naturalWidth) return;
  var canvas = document.getElementById('canvas');
  var ctx = canvas.getContext('2d');
  var layout = previewLayout();
  var ang = layout.angle;
  var w = img.width;
  var h = img.height;

  canvas.width  = PREVIEW_WIDTH;
  canvas.height = PREVIEW_HEIGHT;

  var dx = layout.width / 2;
  var dy = layout.height / 2;
  var scale = layout.fit;
  // console.log("ang:",ang,"flip:",flip,"w:",w,"h:",h,"dx:",dx,"dy:",dy,"scale:",scale);

  scale *= currentScale;
  dx    += currentDeltaX;
  dy    += currentDeltaY;
  // console.log("trans -> scale:",scale,"dx:",dx,"dy:",dy);
  //Pan is limited so at most half the preview is left empty (see clampPan).

  ctx.scale(scale,scale);
  ctx.translate(dx, dy);
  ctx.rotate(ang * Math.PI / 180);
  ctx.translate(-w/2, -h/2);
  ctx.drawImage(img, 0, 0, w, h);
  // var dataUrl = canvas.toDataURL("image/jpg");
  // console.log("imageData: ",imageData.length);
  // console.log("dataURL:   ",dataUrl.length);
}

function rotatePhoto(degrees) {
  imageRot += degrees;
  imageRot = imageRot % 360;
console.log("rotatePhoto("+degrees+") -> " +imageRot);
  posChanged = true;
  rotationChanged = true;
  //The photo's width and height swap, so fit it to the preview again.
  clampPan(true);
  adjustDeltaX = currentDeltaX;
  adjustDeltaY = currentDeltaY;
  $('#save-icon').show();
  updateSaveButton();
  drawImage();
}

{{> game_photo_upload}}

function navigate(url) {
  var modified = imageChanged || posChanged || scoreChanged;
  if(modified) {
    if(window.confirm("Are you sure you want to leave? You will lose your changes")) {
      window.location=url;
    }
    else {
    }
  }
  else {
    window.location=url;
  }
}

function setValues() {
  scores = [
    game.score_1 || 0,
    game.score_2 || 0,
    game.score_3 || 0,
    game.score_4 || 0
  ];

  if(game.photos && game.photos.length > 0) {
    var ph = game.photos[0];
    loadThumb(ph.url);

    imageRot = ph.rot || 0;
    adjustScale = ph.scale || 1;
    adjustDeltaX = ph.dx || 0;
    adjustDeltaY = ph.dy || 0;

    currentScale = adjustScale;
    currentDeltaX = adjustDeltaX;
    currentDeltaY = adjustDeltaY;
  }

  $('#machine-label').text(labels[game.machine]);

  $('#p1').text(labels[game.player_1]);
  $('#p2').text(labels[game.player_2]);
  if(game.score_1 > 0) {
    $('#s1').text(numeral(game.score_1).format());
    $('#s1').addClass('recorded');
  }
  if(game.score_2 > 0) {
    $('#s2').text(numeral(game.score_2).format());
    $('#s2').addClass('recorded');
  }
  $('#pnts1').text(numeral(game.points_1).format('0.0'));
  $('#pnts2').text(numeral(game.points_2).format('0.0'));

  {{#doubles}}
  $('#p3').text(labels[game.player_3]);
  $('#p4').text(labels[game.player_4]);
  if(game.score_3 > 0) {
    $('#s3').text(numeral(game.score_3).format());
    $('#s3').addClass('recorded');
  }
  if(game.score_4 > 0) {
    $('#s4').text(numeral(game.score_4).format());
    $('#s4').addClass('recorded');
  }
  $('#pnts3').text(numeral(game.points_3).format('0.0'));
  $('#pnts4').text(numeral(game.points_4).format('0.0'));

  $('#s13').text(numeral(game.score_13).format());
  $('#p13').text(numeral(game.points_13).format('0.0'));
  $('#s24').text(numeral(game.score_24).format());
  $('#p24').text(numeral(game.points_24).format('0.0'));
  {{/doubles}}

  {{#shared}}
  $('#p3').text(labels[game.player_3]);
  $('#p4').text(labels[game.player_4]);
  {{/shared}}

  imageChanged = false;
  posChanged = false;
  scoreChanged = false;
  rotationChanged = false;
  $('.score').removeClass('score-check');
  $('#save-icon').hide();
  updateSaveButton();
  fitScoreFields();
}

//The score columns have fixed widths, so a score too long for its field
//(e.g. 999,999,999,990 on a small phone) gets smaller text rather than
//widening the column; normal scores keep the full size. Same for the totals.
function fitScoreFields() {
  $('#scores .score, #scores .sum-row .score-total').each(function() {
    //A total's number is in a span with its own size; shrink that, measured against the cell.
    var text = $(this).hasClass('score-total') ? this.firstElementChild : this;
    if(!text) return;
    text.style.fontSize = '';
    var style = getComputedStyle(this);
    var room = this.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - SCORE_FIELD_FIT_MARGIN_PX;
    var size = parseFloat(getComputedStyle(text).fontSize);
    //The text's exact drawn width (scrollWidth is rounded and never less than the box).
    var range = document.createRange();
    range.selectNodeContents(text);
    while(range.getBoundingClientRect().width > room && size > SCORE_FIELD_MIN_FONT_PX) {
      size = Math.max(SCORE_FIELD_MIN_FONT_PX, size - SCORE_FIELD_FONT_STEP_PX);
      text.style.fontSize = size + 'px';
    }
  });
}

function numTapped(n) {
  var i = curScore;
  if(i == -1) return;
  if(n == -1) {
    var s = '' + scores[i];
    scores[i] = numeral().unformat(s.substring(0,s.length-1));
  }
  else {
    var s = scores[i];
    scores[i] = numeral().unformat(s + '' + n);
  }
  var $elm = $('#s'+(i+1));
  $elm.text(numeral(scores[i]).format());
  $elm.removeClass('recorded score-check');
  fitScoreFields();
  scoreChanged = true;
  $('#save-icon').show();
  updateSaveButton();
}

{{> game_detect}}

//Green Save means everything is saved; blue means there are changes to save.
function updateSaveButton() {
  var unsaved = imageChanged || scoreChanged || rotationChanged || !!getInfoChanges();
  $('#save-btn')
    .toggleClass('btn-primary', unsaved)
    .toggleClass('btn-success', !unsaved);
}

function advanceHighlight() {
// console.log("advance:",curScore);
  if(curScore < scores.length - 1) {
    highlightScore(curScore + 1);
  }
}

function retreatHighlight() {
  // console.log("retreat:",curScore);
  if(curScore > 0) {
    highlightScore(curScore - 1);
  }
}

function highlightScore(n) {
// console.log("highlight, curScore:",curScore,"n:",n);
  if(curScore != -1) {
    //Unhighlight the old one.
    var $old = $('#s'+(curScore+1));
    $old.removeClass('highlight');
    if(scores[curScore] == 0) {
      $old.text('Player ' + (curScore+1) + ' Score');
      fitScoreFields();
    }
  }
  curScore = n;
  $('#s'+(n+1)).addClass('highlight');
}

function makeSelect(name, options, selected) {
  var html = '<select id="' +name+ '" class="custom-select">';
  for(var i = 0; i < options.length; i++) {
    var opt = options[i];
    var value = opt.value || opt;
    //Full names; CSS (.custom-select in game.css) adds an ellipsis if they don't fit.
    var label = opt.label || labels[opt];
    var sel = opt == selected ? ' selected' : '';
    html += '<option value="' +value+ '"' +sel+ '>' +label+ '</option>';
  }
  html += '</select>';
  return html;
}

$(document).ready(function() {
console.log("Document ready...");

  //Column widths follow the screen, so long scores are refitted when it changes.
  $(window).on('resize orientationchange', fitScoreFields);

  $(document).keydown(function(e) {
    var x = e.which;
    //While the detected-scores popup is open, keys don't reach the score
    //fields behind it. Escape backs out of the popup's current step.
    if(DetectScores.isOpen()) {
      if(x == KEY_ESCAPE) DetectScores.escape();
      return;
    }
    if(x > 47 && x < 58) {
      var n = x - 48;
      numTapped(n);
    }
    else if(x == 8 || x == 37) {
      numTapped(-1);
    }
    else if(x == 9) {
      if(e.shiftKey) {
        retreatHighlight();
      }
      else {
        advanceHighlight();
      }
      e.preventDefault();
    }
  });

  {{#editable}}
  //A key only counts if the press starts and ends on it, like a normal
  //button. Sliding off a key before lifting cancels the tap.
  var pressedKey = null;

  function keyAtTouch(e) {
    var t = e.originalEvent.changedTouches[0];
    return document.elementFromPoint(t.clientX, t.clientY);
  }

  function clearPress() {
    $('.num').removeClass('num-press');
    pressedKey = null;
  }

  $('.num').on('touchstart mousedown',function(e) {
    pressedKey = this;
    $(this).addClass('num-press');
  });

  $('.num').on('touchmove',function(e) {
    $(this).toggleClass('num-press', keyAtTouch(e) === this);
  });

  $('.num').on('mouseleave',function(e) {
    $(this).removeClass('num-press');
  });

  $('.num').on('mouseenter',function(e) {
    if(pressedKey === this) {
      $(this).addClass('num-press');
    }
  });

  $('.num').on('touchend mouseup',function(e) {
    var released = (e.type == 'touchend') ? keyAtTouch(e) : this;
    var pressed = pressedKey;
    clearPress();
    e.preventDefault();
    if(!pressed || released !== pressed) {
      return;
    }
    var x = $(pressed).text();
    if($(pressed).data('key') == 'back') {
      numTapped(-1);
    }
    else if(x == '000') {
      numTapped(0); numTapped(0); numTapped(0);
    }
    else {
      numTapped(parseInt(x));
    }
  });

  //Releasing or cancelling anywhere else ends the press without a tap.
  $(document).on('mouseup touchcancel', clearPress);

  $('#edit-machine').html(
    makeSelect('machine',machines, game.machine)
  );
  $('#edit-p1').html(
    makeSelect('player_1',left_players, game.player_1)
  );
  $('#edit-p2').html(
    makeSelect('player_2',right_players, game.player_2)
  );
  $('#edit-p3').html(
    makeSelect('player_3',left_players, game.player_3)
  );
  $('#edit-p4').html(
    makeSelect('player_4',right_players, game.player_4)
  );
  $('.score').click(function() {
  // $('.score').on('touchend mouseup',function(e) {
    var n = parseInt(this.id.substring(1,2)) - 1;
    highlightScore(n);
  });
  $('#edit-on').show();

  $('#edit-on').click(function() {
    $('.norm').hide();
    $('.edit').show();
  });
  $('#save-icon').click(function() {
    sendChanges();
  });
  setupImageController();

  $('select').change(function() {
    $('#save-icon').show();
    updateSaveButton();
  });

  //NOTE: TEST TEST TEST
  // $('#zoom').keyup(function() {
  //   var v = $(this).val();
  //   v = parseFloat(v);
  //   console.log("zoom -> " +v);
  //   currentScale = v;
  //   adjustScale = v;
  //   renderImage();
  // });
  //  END TEST

  {{/editable}}

  setValues();
});

/*
Image preview example:
https://developer.mozilla.org/en-US/docs/Using_files_from_web_applications
https://hacks.mozilla.org/2011/01/how-to-develop-a-html5-image-uploader/
*/
