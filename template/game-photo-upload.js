//Photo upload: choosing a photo, the size rules for uploading it, and
//copying its EXIF into a re-encoded JPEG. game.js includes this file as the
//mustache partial "game_photo_upload" (route/mnp.js). Everything here is
//private to the function below except what it returns, so the only global
//name it adds is PhotoUpload. It uses game.js's globals (photoBlob,
//imageChanged, setImageUrl, setSaveStatus ...) and may use mustache values.
var PhotoUpload = (function() {

//Photo upload rules (see prepareUpload).
const UPLOAD_AS_IS_MAX_BYTES = 3000000;
const UPLOAD_TARGET_PIXELS = 1555200;  //1440 x 1080
const UPLOAD_JPEG_QUALITY = 0.9;
//Keep an exact aspect ratio if that lands within 2% of the target pixel count.
const UPLOAD_EXACT_RATIO_TOLERANCE = 0.02;
//EXIF handling for re-encoded photos (see copyExif).
const EXIF_SCAN_BYTES = 131072;  //EXIF must sit in one APP1 segment (max 64 KB) near the start of the file
const JPEG_MARKER = 0xFF;
const JPEG_SOI = 0xD8;
const JPEG_EOI = 0xD9;
const JPEG_SOS = 0xDA;
const JPEG_APP0 = 0xE0;
const JPEG_APP1 = 0xE1;
const EXIF_TIFF_OFFSET = 10;  //marker(2) + length(2) + "Exif\0\0"(6)
const EXIF_IFD_ENTRY_SIZE = 12;
const EXIF_TIFF_LITTLE_ENDIAN = 0x4949;  //"II"
const EXIF_TAG_ORIENTATION = 0x0112;
const EXIF_TAG_EXIF_IFD = 0x8769;
const EXIF_TAG_PIXEL_X = 0xA002;
const EXIF_TAG_PIXEL_Y = 0xA003;
const EXIF_TYPE_SHORT = 3;
const EXIF_TYPE_LONG = 4;
const EXIF_ORIENTATION_NORMAL = 1;
//Largest photo the server accepts (lib/photos.js PHOTO_MAX_BYTES).
const PHOTO_MAX_BYTES = {{photo_max_bytes}};
const BYTES_PER_MEGABYTE = 1024 * 1024;
const PHOTO_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif'
};

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
  prepareUpload(file, function(blob) {
    if(blob.size > PHOTO_MAX_BYTES) {
      setSaveStatus("This photo is too large to upload (" + megabytes(blob.size) + " MB; the limit is " +
        megabytes(PHOTO_MAX_BYTES) + " MB). Choose a smaller photo.", true);
      return;
    }
    //Reset transform values for new images: both the saved framing and the
    //live one the preview draws with (drawImage uses current*), or the new
    //photo inherits the previous photo's zoom and pan.
    imageRot      = 0;
    adjustScale   = 1;
    adjustDeltaX  = 0;
    adjustDeltaY  = 0;
    currentScale  = 1;
    currentDeltaX = 0;
    currentDeltaY = 0;
    fitNewPhoto = true;
    photoBlob = blob;
    setImageUrl(URL.createObjectURL(blob));
    //TODO: We should do sha or md5 to compare photos
    imageChanged = true;
    $('#save-icon').show();
    updateSaveButton();
    //Bring the Choose File row to the top of the screen, so the photo, the
    //scores, and (on most phones) Detect Scores and Save are in view.
    var photoRow = $('label[for=photos]').closest('table')[0];
    if(photoRow) {
      photoRow.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });
}

function megabytes(bytes) {
  return (bytes / BYTES_PER_MEGABYTE).toFixed(1);
}

//Name sent with the upload; the server works out the type from the bytes.
function photoFilename(blob) {
  var ext = PHOTO_EXTENSIONS[blob.type] || '';
  return 'photo' + ext;
}

//Files up to UPLOAD_AS_IS_MAX_BYTES are sent untouched to avoid any quality loss.
//Larger files are scaled down to about UPLOAD_TARGET_PIXELS (keeping the aspect
//ratio) if bigger than that, and re-encoded as JPEG. Calls back with a Blob.
function prepareUpload(file, callback) {
  console.log("prepareUpload():", file.type, file.size, "bytes");
  if(file.size <= UPLOAD_AS_IS_MAX_BYTES) {
    return callback(file);
  }
  var fileUrl = URL.createObjectURL(file);
  var img = document.createElement('img');
  img.onload = function() {
    URL.revokeObjectURL(fileUrl);
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
    canvas.toBlob(function(jpeg) {
      if(!jpeg) {
        console.log("prepareUpload(): couldn't encode JPEG, sending as-is");
        return callback(file);
      }
      copyExif(file, jpeg, w, h, callback);
    }, 'image/jpeg', UPLOAD_JPEG_QUALITY);
  };
  //Formats this browser can't decode (e.g. HEIC outside Safari) are sent as-is.
  img.onerror = function() {
    URL.revokeObjectURL(fileUrl);
    console.log("prepareUpload(): browser can't decode " + file.type + ", sending as-is");
    callback(file);
  };
  img.src = fileUrl;
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
function copyExif(file, jpeg, width, height, callback) {
  Promise.all([file.slice(0, EXIF_SCAN_BYTES).arrayBuffer(), jpeg.arrayBuffer()]).then(function(bufs) {
    var out = jpeg;
    try {
      var seg = findExifSegment(new Uint8Array(bufs[0]));
      if(seg) {
        patchExif(seg, width, height);
        out = new Blob([insertExif(new Uint8Array(bufs[1]), seg)], { type: 'image/jpeg' });
        console.log("copyExif(): kept " + seg.length + " bytes of EXIF");
      }
    }
    catch(err) {
      console.log("copyExif(): uploading without EXIF:", err);
    }
    callback(out);
  }, function(err) {
    console.log("copyExif(): couldn't read file, uploading without EXIF:", err);
    callback(jpeg);
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

return {
  preview: preview,
  photoFilename: photoFilename
};
})();
