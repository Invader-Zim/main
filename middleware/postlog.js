var express = require('express');
var fs = require('fs');
var util = require('../lib/util');
var photos = require('../lib/photos');
var matches = require('../model/matches');
var CONST = require('../constants');

var router = express.Router();

const config = require('../config');
const DATA_FOLDER = config.DATA_FOLDER;

//NOTE: By placing this middleware AFTER the users middleware,
//	all the login, logout, and signup routes will be
//	handled before this, which is nice to avoid
//	logging passwords in the log.

console.log("Loaded postlog.js");

router.post('/games/:game_id/report', function(req, res, next) {
   var gameId = req.params.game_id;
   var parts = gameId && gameId.split('.');
   var matchId = parts && parts[0];
   var game = parts && (parts.length >= 3) && parts[2];
   var match = matchId && matches.get(matchId);

   if (match) {
      req._match = match;
   }
   if (game) {
      req._game = game;
   }
   next();
});

// Capture the match info when available.

router.post('/matches/:match_id/*', function(req, res, next) {
   var match = matches.get(req.params.match_id);

   if (match) {
      req._match = match;
   }
   next();
});

// Note when both lineups are ready and confirmed. This handler runs before
// the one that updates the match to reflect the final confirmation.

router.post('/matches/:match_id/confirm', function(req, res, next) {
   var match = req._match;

   if (req.body && match && (match.state == CONST.PREGAME) && match.away && match.home && match.away.ready && match.home.ready) {
      req._confirmed = (match.home.confirmed && req.body.right) || (match.away.confirmed && req.body.left);
   } else {
      req._confirmed = false;
   }
   next();
});

//I also want to log ALL POST operations to a file.
router.post('/*',function(req,res,next) {
  console.log("RECORDING POST....");

  //TODO: Semi weird to do this photo scrubbing here,
  //	  but I'm just moving the data so that we don't
  //      dump a bunch of junk. We could also intercept
  //      a standardized convention for photos and save
  //      them to a cache, and attach the filename to
  //      the req.

  //The photo file is written by the route after it validates the request
  //(see savePhoto in route/mnp.js), so rejected posts don't leave files.
  //Photos arrive as raw bytes (multipart, see middleware/photo-upload.js), or
  //from older pages as a base64 data URL in photo_data, which is decoded here
  //so everything is stored as raw bytes named by the sha1 of those bytes.
  var photoBytes = null;
  if(req.file) {
    photoBytes = req.file.buffer;
  }
  else if(req.body.photo_data && photos.isDataUrl(req.body.photo_data)) {
    var decoded = photos.decodeDataUrl(req.body.photo_data);
    photoBytes = decoded ? decoded.buffer : Buffer.alloc(0);
  }
  else if(req.body.photo_data) {
    //Only the server sets photo_data to a sha; ignore anything else a client sends.
    delete req.body.photo_data;
  }
  if(photoBytes) {
    var sha = util.digest(photoBytes);
    req._photo = { sha: sha, data: photoBytes, type: photos.detectImageType(photoBytes) };
    req.body.photo_data = sha;
    console.log("Received photo data ... " + photoBytes.length + " bytes, " + (req._photo.type || "unrecognized type"));
  }
  else console.log("No photo data");

  var data = {
    path: req.path,
    body: req.body,
    when: Date.now(),
    user_id: req.user.id,
    ukey: req.user.key
  };

  emit(req, data);

  if (req._match && req._confirmed) {
     const match = req._match;

     emit(req, {
        when: Date.now(),
        path: "/matches/" + match.key + "/lineups",
        body: {
           venue: match.venue,
           away: match.away.lineup,
           home: match.home.lineup
        }
     });
  }

  next();

  function emit(req, data) {
     var augmented = data;

     if (req._match && isPureObject(data)) {
        const match = req._match;
        const body = {
           key: match.key,
           state: match.state,
           round: match.round
        };

        if (req._game) {
           body.game = req._game;
        }
        augmented = {...data};
        // Combine bodies. If a field was present in the original post, keep the original
        augmented.body = (data.body) ? {...body, ...data.body} : body;
     }
     var chunk = JSON.stringify(augmented, null, 2);
     var id = util.digest(chunk);

     fs.writeFileSync(DATA_FOLDER + '/posts/' + id, chunk);
  }

  // isPureObject: only true for a plain-old JS object which is not a String or Array or Date

  function isPureObject(value) {
     return Object.prototype.toString.call(value) === '[object Object]';
  }
});

module.exports = router;
