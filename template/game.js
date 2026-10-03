var labels = {{&labels}};
var game = {{&game}};
var machines = {{&machines}};
var left_players = {{&left_players}};
var right_players = {{&right_players}};
var curScore = -1;
var scores = [0,0,0,0];
var imageData;
var imageRot = 0;
var imageChanged = false;
var posChanged = false;
var scoreChanged = false;
//Rotating is a deliberate edit, unlike pinch/pan which people use just to read the photo.
var rotationChanged = false;

var adjustScale = 1;
var adjustDeltaX = 0;
var adjustDeltaY = 0;

var SAVE_TIMEOUT_MS = 60000;
var HTTP_CLIENT_ERROR = 400;
var HTTP_SERVER_ERROR = 500;
var HTTP_PAYLOAD_TOO_LARGE = 413;
//How long the checkmark stays solid before it starts to grow and fade.
var SUCCESS_HOLD_MS = 1000;
//Must match the .success-begin transition time in game.css.
var SUCCESS_ANIMATION_MS = 2000;
var SUCCESS_HIDE_DELAY_MS = 10;
//Saves faster than this hold the full progress bar so people can see it.
var FAST_SAVE_MS = 1000;
var FULL_BAR_HOLD_MS = 500;
//How long the red X stays up after a failed save.
var FAILURE_SHOW_MS = 3000;
//Photo upload rules (see prepareUpload).
var UPLOAD_AS_IS_MAX_BYTES = 3000000;
var UPLOAD_TARGET_PIXELS = 1555200;  //1440 x 1080
var UPLOAD_JPEG_QUALITY = 0.9;
//Keep an exact aspect ratio if that lands within 2% of the target pixel count.
var UPLOAD_EXACT_RATIO_TOLERANCE = 0.02;
//EXIF handling for re-encoded photos (see copyExif).
var EXIF_SCAN_BYTES = 131072;  //EXIF must sit in one APP1 segment (max 64 KB) near the start of the file
var JPEG_MARKER = 0xFF;
var JPEG_SOI = 0xD8;
var JPEG_EOI = 0xD9;
var JPEG_SOS = 0xDA;
var JPEG_APP0 = 0xE0;
var JPEG_APP1 = 0xE1;
var EXIF_TIFF_OFFSET = 10;  //marker(2) + length(2) + "Exif\0\0"(6)
var EXIF_IFD_ENTRY_SIZE = 12;
var EXIF_TIFF_LITTLE_ENDIAN = 0x4949;  //"II"
var EXIF_TAG_ORIENTATION = 0x0112;
var EXIF_TAG_EXIF_IFD = 0x8769;
var EXIF_TAG_PIXEL_X = 0xA002;
var EXIF_TAG_PIXEL_Y = 0xA003;
var EXIF_TYPE_SHORT = 3;
var EXIF_TYPE_LONG = 4;
var EXIF_ORIENTATION_NORMAL = 1;
var STRING_CHUNK_SIZE = 0x8000;
var failureTimer = null;

function sendChanges() {
  console.log("sendChanges() ...");
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
    console.log("++ imageData len:",imageData.length);
    data.photo_data = imageData;
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
    sendData(data);
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
  hint = hint || "Your changes are still here. Press SAVE to try again.";
  setSaveStatus("Save failed: " + reason + " " + hint, true);
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

function sendData(data) {
  if(!data) return;
  console.log("sendData...");
  console.log("length:",JSON.stringify(data).length);
  var sentPhoto = !!data.photo_data;
  var startTime = Date.now();
  hideFailure();
  setSaveStatus("", false);
  $('#progress').css('width','0%');
  $.ajax({
    xhr: function() {
      var x = new XMLHttpRequest();
      $('.modal-cover').show();
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
    data: data,
    method: 'POST',
    timeout: SAVE_TIMEOUT_MS,
    success: function(result) {
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
        showSuccess();
        var time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        setSaveStatus("✓ Saved at " + time + (sentPhoto ? " (photo uploaded)" : ""), false);
      });
    },
    error: function(xhr, status, err) {
      console.log("... send failed:", status, err);
      if(status == 'timeout') {
        saveFailed("The upload timed out.");
      }
      else if(xhr.status == 0) {
        saveFailed("Could not reach the server. Check your connection.");
      }
      else if(xhr.status == HTTP_PAYLOAD_TOO_LARGE) {
        saveFailed("The photo is too large to upload.", "Choose a smaller photo, then press SAVE.");
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

function loadThumb(url) {
  if(curImageUrl == url) {
    console.log("Already loaded " +url);
    return;
  }
  curImageUrl = url;
console.log("Trying to load thumb: " +url);
  $.ajax({
    xhr: function() {
      var x = new XMLHttpRequest();
      x.onprogress = function(e) {
        console.log("prog:",e);
        if(e.lengthComputable) {
          var pct = 100 * e.loaded / e.total;
          // $('#progress').css('width',pct+'%');
          // TODO: Just let the image fill in as it loads.
        }
      }
      return x;
    },
    url: url,
    success: function(data) {
console.log("success!",data.length);
      // $('#progress').css('width','0%');
      setImageData(data);
      // transformPhoto();
    },
    error: function(xhr, status, err) {
      // $('#progress').css('width','0%');
      console.log(status,err);
    }
  });
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
  pinch.recognizeWith(pan);
  mc.add([pinch,pan]);

  // Handles pinch and pan events/transforming at the same time;
  mc.on("pinch pan", function (ev) {
    // Adjusting the current pinch/pan event properties using the previous ones set when they finished touching
    currentScale = adjustScale * ev.scale;
    currentDeltaX = adjustDeltaX + (ev.deltaX / currentScale);
    currentDeltaY = adjustDeltaY + (ev.deltaY / currentScale);
    posChanged = true;
    drawImage();
  });

  mc.on("panend pinchend", function (ev) {
    // Saving the final transforms for adjustment next time the user interacts.
    adjustScale = currentScale;
    adjustDeltaX = currentDeltaX;
    adjustDeltaY = currentDeltaY;
    $('#save-icon').show();
  });
}

function setImageData(data) {
console.log("setImageData()...");
  imageData = data;
  renderImage();
  $('#canvas').show();
  $('#cell-left').show();
  $('#cell-right').show();
}

var imgElm;
function setupImage() {
  imgElm = document.createElement('img');
  imgElm.onload = function() {
    drawImage();
  };
}

function renderImage() {
  if(!imgElm) setupImage();
  imgElm.src = imageData;
}

function drawImage() {
  var img = imgElm;
  var MAX_WIDTH = 300;
  var MAX_HEIGHT = 188;

  var canvas = document.getElementById('canvas');
  var ctx = canvas.getContext('2d');
  var ang = (imageRot + 360) % 360;

  var w = img.width;
  var h = img.height;

  canvas.width  = MAX_WIDTH;
  canvas.height = MAX_HEIGHT;

  var flip = (ang == 90 || ang == 270);
  var dx = flip ? h/2 : w/2;
  var dy = flip ? w/2 : h/2;

  //Calc scale factor.
  var scale = 1;
  if(flip) {
    if(w > h) {
// console.log("Case 1: flip,w>h,",MAX_HEIGHT + " / " + w);
      scale = MAX_HEIGHT / w;
    }
    else {
// console.log("Case 2: flip,h>=w,",MAX_WIDTH + " / " + h);
      scale = MAX_WIDTH / h;
    }
  }
  else {
    if(w > h) {
// console.log("Case 3: w>h,",MAX_WIDTH + " / " + w);
      scale = MAX_WIDTH / w;
    }
    else {
// console.log("Case 4: h>=w,",MAX_HEIGHT + " / " + h);
      scale = MAX_HEIGHT / h;
    }
  }
  // console.log("ang:",ang,"flip:",flip,"w:",w,"h:",h,"dx:",dx,"dy:",dy,"scale:",scale);

  scale *= currentScale;
  dx    += currentDeltaX;
  dy    += currentDeltaY;
  // console.log("trans -> scale:",scale,"dx:",dx,"dy:",dy);
  //TODO: Clamp dx and dy to meaningful range.

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
  $('#save-icon').show();
  updateSaveButton();
  drawImage();
}

function preview(files) {
console.log("preview(), files.length:",files.length);
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var imageType = /^image\//;

    if (!imageType.test(file.type)) {
      continue;
    }
    readPhoto(file);
  }
}

function readPhoto(file) {
  var reader = new FileReader();
  reader.onload = function(e) {
    prepareUpload(file, e.target.result, function(uploadData) {
      //Reset transform values for new images.
      imageRot     = 0;
      adjustScale  = 1;
      adjustDeltaX = 0;
      adjustDeltaY = 0;
      setImageData(uploadData);
      //TODO: We should do sha or md5 to compare imageData
      imageChanged = true;
      $('#save-icon').show();
      updateSaveButton();
    });
  };
  reader.readAsDataURL(file);
}

//Files up to UPLOAD_AS_IS_MAX_BYTES are sent untouched to avoid any quality loss.
//Larger files are scaled down to about UPLOAD_TARGET_PIXELS (keeping the aspect
//ratio) if bigger than that, and re-encoded as JPEG.
function prepareUpload(file, dataUrl, callback) {
  console.log("prepareUpload():", file.type, file.size, "bytes");
  if(file.size <= UPLOAD_AS_IS_MAX_BYTES) {
    return callback(dataUrl);
  }
  var img = document.createElement('img');
  img.onload = function() {
    var w = img.naturalWidth;
    var h = img.naturalHeight;
    if(w * h > UPLOAD_TARGET_PIXELS) {
      var size = scaledSize(w, h);
      w = size.w;
      h = size.h;
    }
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    //JPEG has no transparency; use white instead of black behind any transparent areas.
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    console.log("prepareUpload(): " + img.naturalWidth + "x" + img.naturalHeight + " -> " + w + "x" + h + " JPEG");
    copyExif(file, canvas.toDataURL('image/jpeg', UPLOAD_JPEG_QUALITY), w, h, callback);
  };
  //Formats this browser can't decode (e.g. HEIC outside Safari) are sent as-is.
  img.onerror = function() {
    console.log("prepareUpload(): browser can't decode " + file.type + ", sending as-is");
    callback(dataUrl);
  };
  img.src = dataUrl;
}

//Size for scaling w x h down to about UPLOAD_TARGET_PIXELS. When the aspect
//ratio reduces to small whole numbers a:b (16:9, 4:3, ...), use an exact
//multiple (a*k x b*k) so the ratio is kept exactly, e.g. 4032x2268 -> 1664x936.
//Otherwise round the ideal size: h = sqrt(target / aspect), w = h * aspect.
function scaledSize(w, h) {
  var g = greatestCommonDivisor(w, h);
  var a = w / g;
  var b = h / g;
  var ideal = Math.sqrt(UPLOAD_TARGET_PIXELS / (a * b));
  var best = null;
  [Math.floor(ideal), Math.ceil(ideal)].forEach(function(k) {
    //k can't exceed g, which would be larger than the original.
    if(k < 1 || k > g) return;
    var diff = Math.abs(a * k * b * k - UPLOAD_TARGET_PIXELS);
    if(!best || diff < best.diff) best = { w: a * k, h: b * k, diff: diff };
  });
  if(best && best.diff <= UPLOAD_TARGET_PIXELS * UPLOAD_EXACT_RATIO_TOLERANCE) {
    return { w: best.w, h: best.h };
  }
  var aspect = w / h;
  var sh = Math.round(Math.sqrt(UPLOAD_TARGET_PIXELS / aspect));
  return { w: Math.round(sh * aspect), h: sh };
}

function greatestCommonDivisor(a, b) {
  while(b) {
    var t = b;
    b = a % b;
    a = t;
  }
  return a;
}

//Carry the original JPEG's EXIF (camera, time, location, ...) over to the
//re-encoded JPEG. Only the EXIF block is copied, not the color profile: the
//canvas has already converted colors and applied the rotation.
function copyExif(file, jpegUrl, width, height, callback) {
  file.slice(0, EXIF_SCAN_BYTES).arrayBuffer().then(function(buf) {
    var out = jpegUrl;
    try {
      var seg = findExifSegment(new Uint8Array(buf));
      if(seg) {
        patchExif(seg, width, height);
        out = bytesToDataUrl(insertExif(dataUrlToBytes(jpegUrl), seg), 'image/jpeg');
        console.log("copyExif(): kept " + seg.length + " bytes of EXIF");
      }
    }
    catch(err) {
      console.log("copyExif(): uploading without EXIF:", err);
    }
    callback(out);
  }, function(err) {
    console.log("copyExif(): couldn't read file, uploading without EXIF:", err);
    callback(jpegUrl);
  });
}

//Returns a copy of the JPEG's EXIF APP1 segment (marker included), or null.
function findExifSegment(bytes) {
  if(bytes[0] != JPEG_MARKER || bytes[1] != JPEG_SOI) return null;
  var i = 2;
  while(i + 4 <= bytes.length && bytes[i] == JPEG_MARKER) {
    var marker = bytes[i+1];
    if(marker == JPEG_SOS || marker == JPEG_EOI) break;
    var len = (bytes[i+2] << 8) | bytes[i+3];
    if(marker == JPEG_APP1 && isExifHeader(bytes, i + 4)) {
      return (i + 2 + len <= bytes.length) ? bytes.slice(i, i + 2 + len) : null;
    }
    i += 2 + len;
  }
  return null;
}

function isExifHeader(b, o) {
  //"Exif\0\0"
  return b[o] == 0x45 && b[o+1] == 0x78 && b[o+2] == 0x69 && b[o+3] == 0x66 && b[o+4] == 0 && b[o+5] == 0;
}

//Fix the copied EXIF for the re-encoded image: rotation is already applied,
//the size changed, and the embedded thumbnail shows the old orientation.
function patchExif(seg, width, height) {
  var view = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
  var tiff = EXIF_TIFF_OFFSET;
  var le = view.getUint16(tiff) == EXIF_TIFF_LITTLE_ENDIAN;
  var ifd0 = tiff + view.getUint32(tiff + 4, le);
  var exifIfd = null;
  forEachIfdEntry(view, ifd0, le, function(entry, tag) {
    if(tag == EXIF_TAG_ORIENTATION) view.setUint16(entry + 8, EXIF_ORIENTATION_NORMAL, le);
    if(tag == EXIF_TAG_EXIF_IFD) exifIfd = tiff + view.getUint32(entry + 8, le);
  });
  //Unlink IFD1 (the embedded thumbnail).
  var count = view.getUint16(ifd0, le);
  view.setUint32(ifd0 + 2 + count * EXIF_IFD_ENTRY_SIZE, 0, le);
  if(exifIfd) {
    forEachIfdEntry(view, exifIfd, le, function(entry, tag) {
      if(tag == EXIF_TAG_PIXEL_X) setExifNumber(view, entry, width, le);
      if(tag == EXIF_TAG_PIXEL_Y) setExifNumber(view, entry, height, le);
    });
  }
}

function forEachIfdEntry(view, ifd, le, fn) {
  var count = view.getUint16(ifd, le);
  for(var k = 0; k < count; k++) {
    var entry = ifd + 2 + k * EXIF_IFD_ENTRY_SIZE;
    fn(entry, view.getUint16(entry, le));
  }
}

function setExifNumber(view, entry, value, le) {
  var type = view.getUint16(entry + 2, le);
  if(type == EXIF_TYPE_SHORT) view.setUint16(entry + 8, value, le);
  else if(type == EXIF_TYPE_LONG) view.setUint32(entry + 8, value, le);
}

//Put the EXIF segment right after the JFIF (APP0) header, or after SOI if there is none.
function insertExif(jpeg, seg) {
  var pos = 2;
  if(jpeg[2] == JPEG_MARKER && jpeg[3] == JPEG_APP0) {
    pos = 4 + ((jpeg[4] << 8) | jpeg[5]);
  }
  var out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, pos), 0);
  out.set(seg, pos);
  out.set(jpeg.subarray(pos), pos + seg.length);
  return out;
}

function dataUrlToBytes(dataUrl) {
  var bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  var bytes = new Uint8Array(bin.length);
  for(var i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function bytesToDataUrl(bytes, type) {
  var bin = '';
  for(var i = 0; i < bytes.length; i += STRING_CHUNK_SIZE) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STRING_CHUNK_SIZE));
  }
  return 'data:' + type + ';base64,' + btoa(bin);
}

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
  $('#save-icon').hide();
  updateSaveButton();
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
  $elm.removeClass('recorded');
  scoreChanged = true;
  $('#save-icon').show();
  updateSaveButton();
}

//Green SAVE means everything is saved; blue means there are changes to save.
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
    var label = opt.label || labels[opt];
    if(label.length > 10) {
      label = label.substring(0,10);
    }
    var sel = opt == selected ? ' selected' : '';
    html += '<option value="' +value+ '"' +sel+ '>' +label+ '</option>';
  }
  html += '</select>';
  return html;
}

$(document).ready(function() {
console.log("Document ready...");

  $(document).keydown(function(e) {
    var x = e.which;
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
