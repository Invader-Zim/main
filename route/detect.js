//Score detection: POST /games/:key.:round.:n/detect reads a game's saved
//photo with the score service (lib/score-service.js) and returns what the
//page's Detect Scores popup needs (template/game-detect.js).
var express = require('express');
var router = express.Router();
var fs = require('fs');
const config = require('../config');
const UPLOADS_FOLDER = config.UPLOADS_FOLDER;
var util = require('../lib/util');
const photos = require('../lib/photos');
const scoreService = require('../lib/score-service');
var matches = require('../model/matches');

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
const HTTP_UNPROCESSABLE = 422;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;
const DETECT_LIMIT_PER_WINDOW = 30;
const DETECT_WINDOW_MS = 60 * 60 * 1000;
const DETECT_CACHE_MAX = 500;
const DETECT_POWERED_BY = 'Powered by Flippd Pinball Vision.';
//Score service status -> what the page is told.
const DETECT_FAILURE_DEFAULT = { status: HTTP_BAD_GATEWAY, message: "Score detection is unavailable right now." };
const DETECT_FAILURES = {
  413: { status: HTTP_PAYLOAD_TOO_LARGE, message: "The photo is too large for score detection." },
  422: { status: HTTP_UNPROCESSABLE, message: "The photo couldn't be read." },
  429: { status: HTTP_SERVICE_UNAVAILABLE, message: "Score detection is busy. Try again in a moment." },
  503: { status: HTTP_SERVICE_UNAVAILABLE, message: "Score detection is busy. Try again in a moment." }
};
var detectCache = new Map();   //photo+framing -> result
var detectHistory = {};        //ukey -> recent detection times

//Score detection: reads the game's saved photo with the score service.
//Following the service's client guide, the page never sends an image here; it
//asks "detect the scores for this game" and the server uses the stored photo
//and framing. Limited to logged-in players who may report the game, capped per
//player, and cached per photo+framing so repeats cost nothing.
router.post('/games/:key.:round.:n/detect', function(req,res) {
  var match = matches.get(req.params.key);
  var round = req.params.round;
  var n = req.params.n ? parseInt(req.params.n) : 0;
  var ukey = req.user.key;

  if(!match || !match.getGame(round,n)) {
    return res.status(HTTP_NOT_FOUND).send("Unknown game.");
  }
  if(!ukey) {
    return res.status(HTTP_UNAUTHORIZED).send("Log in to detect scores.");
  }
  if(!match.canReport({ ukey: ukey, round: round, n: n })) {
    return res.status(HTTP_FORBIDDEN).send("You are not allowed to report scores for this game.");
  }
  //Our page's scripts send this header; other sites' pages can't add it.
  if(req.get('X-Requested-With') != 'XMLHttpRequest') {
    return res.status(HTTP_FORBIDDEN).send("Request not allowed.");
  }
  if(!scoreService.isAvailable()) {
    return res.status(HTTP_SERVICE_UNAVAILABLE).send("Score detection isn't available on this server.");
  }

  var game = match.getGame(round,n);
  var photo = game.photos && game.photos[0];
  var sha = photos.currentPhotoSha(game);
  var filename = UPLOADS_FOLDER + '/' + sha;
  if(!sha || !photos.PHOTO_ID_PATTERN.test(sha) || !util.fileExists(filename)) {
    return res.status(HTTP_BAD_REQUEST).send("Save a photo of the scores first.");
  }
  //Read the photo the page is showing, not a newer one someone else saved.
  if(req.body.photo_id != sha) {
    return res.status(HTTP_CONFLICT).send(photos.PHOTO_CHANGED_MESSAGE);
  }

  //Send the stored framing exactly as saved (all four or none), per the guide.
  var params = { playerCount: matches.NUM_SCORES[round-1] };
  if(photo.rot !== undefined && photo.scale !== undefined && photo.dx !== undefined && photo.dy !== undefined) {
    params.rot = photo.rot;
    params.scale = photo.scale;
    params.dx = photo.dx;
    params.dy = photo.dy;
  }
  var cacheKey = [sha, params.playerCount, params.rot, params.scale, params.dx, params.dy].join('|');
  if(detectCache.has(cacheKey)) {
    console.log("detect: cached result for " + ukey + " " + cacheKey);
    return res.json(detectCache.get(cacheKey));
  }
  if(!allowDetection(ukey)) {
    return res.status(HTTP_TOO_MANY_REQUESTS).send("Too many score detections. Try again later.");
  }

  console.log("detect: " + ukey + " " + req.params.key + "." + round + "." + n + " " + JSON.stringify(params));
  var photoBytes = fs.readFileSync(filename);
  scoreService.recognize(photoBytes, params, function(err, answer) {
    if(err) {
      console.log("detect: score service unreachable:", err.message);
      return res.status(HTTP_BAD_GATEWAY).send("Score detection is unavailable right now.");
    }
    if(answer.status != HTTP_OK) {
      //Log the service's details here; don't pass them to the page.
      console.log("detect: score service " + answer.status + " " + JSON.stringify(answer.body) + " requestId=" + answer.requestId);
      if(answer.status == HTTP_UNSUPPORTED_MEDIA_TYPE) {
        //Name the format, worked out from the photo's own bytes.
        return res.status(HTTP_UNPROCESSABLE).send("The photo's format (" + storedPhotoFormat(photoBytes) + ") can't be read by score detection.");
      }
      var failure = DETECT_FAILURES[answer.status] || DETECT_FAILURE_DEFAULT;
      return res.status(failure.status).send(failure.message);
    }
    var result = detectionResult(answer.body, params.playerCount);
    console.log("detect: requestId=" + answer.requestId + " " + JSON.stringify(result.scores));
    rememberDetection(cacheKey, result);
    res.json(result);
  });
});

//Format name of a stored photo (older uploads are data-URL text; name the image inside).
function storedPhotoFormat(bytes) {
  if(photos.isDataUrl(bytes)) {
    var decoded = photos.decodeDataUrl(bytes.toString('latin1'));
    if(decoded) bytes = decoded.buffer;
  }
  return photos.photoFormatName(bytes);
}

//Where a score was read, in pixels of the uploaded photo turned upright (the
//service's "upright-original" space, which is how browsers show the photo).
//The page crops the photo to these. Null unless all four edges are numbers.
function scoreBounds(b) {
  if(!b || !['left', 'top', 'right', 'bottom'].every(function(k) { return typeof b[k] == 'number'; })) {
    return null;
  }
  return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
}

//A score box's four corners (TL, TR, BR, BL) in the same upright pixels as
//its bounds; on a tilted photo they carry the slant. Null unless well formed.
function scoreCorners(points) {
  var ok = Array.isArray(points) && points.length == 4 && points.every(function(pt) {
    return Array.isArray(pt) && pt.length == 2 && typeof pt[0] == 'number' && typeof pt[1] == 'number';
  });
  return ok ? points.map(function(pt) { return [pt[0], pt[1]]; }) : null;
}

//Only what the page needs: one entry per seat (null if unread) and the credit line.
function detectionResult(body, playerCount) {
  var positions = (body && body.scores && body.scores.positions) || [];
  var scores = [];
  for(var i = 1; i <= playerCount; i++) {
    var seat = positions.find(function(p) { return p.position == i; });
    var s = seat && seat.score;
    scores.push(s && typeof s.numericValue == 'number' ? {
      value: s.numericValue,
      confidence: s.confidence,
      placement: s.placement,
      bounds: scoreBounds(s.bounds),
      corners: scoreCorners(s.cornerPoints)
    } : null);
  }
  var poweredBy = (body && body.attribution && body.attribution.poweredBy) || DETECT_POWERED_BY;
  //The tilt the service measured on the score boxes (degrees; positive means
  //turned clockwise in the photo), or null. The page levels its crop with it.
  var tilt = body && body.scores && body.scores.tiltDegrees;
  return { scores: scores, tiltDegrees: typeof tilt == 'number' ? tilt : null, poweredBy: poweredBy };
}

//Per-player sliding window, below the service's own per-key limit.
function allowDetection(ukey) {
  var now = Date.now();
  var recent = (detectHistory[ukey] || []).filter(function(t) { return now - t < DETECT_WINDOW_MS; });
  if(recent.length >= DETECT_LIMIT_PER_WINDOW) {
    detectHistory[ukey] = recent;
    return false;
  }
  recent.push(now);
  detectHistory[ukey] = recent;
  return true;
}

function rememberDetection(key, result) {
  if(detectCache.size >= DETECT_CACHE_MAX) {
    //Maps keep insertion order; drop the oldest.
    detectCache.delete(detectCache.keys().next().value);
  }
  detectCache.set(key, result);
}

module.exports = router;
