var fs = require('fs');
var mustache = require('mustache');
var ids = require('../lib/ids');
// TODO: Move the email integration into the router?
var email = require('../lib/email');
var util = require('../lib/util');
var Auth = require('../lib/auth');
const makeKey = require('../lib/make-key');
const DATA_FOLDER = require('../config').DATA_FOLDER;
var _map = {};

function getQuestion() {
  return "Please enter the PIN code (obtained from your captain)"
}

function getCorrectAnswer() {
  var date = new Date();
  var dayOfMonth = date.getDate();
  var year = date.getFullYear() % 100;
  var month = date.getMonth() + 1; // return 0 for January
  const zeroPad = (num, places) => String(num).padStart(places, '0')
  return year.toString() + zeroPad(month,2) + zeroPad(dayOfMonth,2);
}


// TODO: ALERT, destroy player isn't erasing anything but the player file.
function destroyPlayer(k) {
  delete _map[k];
  const filename = DATA_FOLDER + `/players/${k}`;
  if(util.fileExists(filename)) {
    fs.unlinkSync(filename);
  }
}

function getPlayer(k) {
  //var key = k.toLowerCase();
  var key = k; //.toLowerCase();
  var p = _map[key]; //This would be replaced by a mongo.get/findOne.
  if(!p) {
    //Try to load from disk.
    var filename = DATA_FOLDER + '/players/' + key;
    if(util.fileExists(filename)) {
      try {
        var raw = fs.readFileSync(DATA_FOLDER + '/players/' + key);
        p = JSON.parse(raw);
      } catch (e) {
        console.log(e);
        console.log(filename);
      }
      if(p) _map[key] = p;
    }
    else {
      // console.log("Nothing found for " +k);
    }
  }
  if(p) {
    p.save = function() {
      savePlayer(this);
    };
  }
  return p; //Or callback(p);
}

function getAll() {
  // var list = fs.readdirSync(DATA_FOLDER + '/players');
  var list = fs.readdirSync(DATA_FOLDER + '/players').filter(function(file) {
    if(file.indexOf(".")==-1)return file;
  })

  var results = [];
  for(i in list) {
    var p = getPlayer(list[i]);
    if(p) results.push(p);
  }
  return results;
}

//TODO: load players from db? See hack at the bottom of the file.

// TODO: We should be doing this on the client side!
function passesMatch(params) {
  var p1 = params.pass || 'p1';
  var p2 = params.conf || 'p2';
  return p1 == p2;
}

function playerExists(key) {
  var k = key.toLowerCase();
  if(_map[k]) return true;
  if(util.fileExists(DATA_FOLDER + '/players/' + k)) return true;
  return false;
}

function savePlayer(player) {
  try {
    fs.writeFileSync(DATA_FOLDER + '/players/' + player.key,JSON.stringify(player,null,2));
  } catch (err) {
    console.log(err);
  }
}

function cleanedName(rawName) {
  var cleaned = rawName.replace(/[&\/\\#,+()$~%":*?<>{}]/g, '')
  var truncated = cleaned.substring(0, 50);
  return truncated
}

function isBogusName(rawName) {
  var cleaned = cleanedName(rawName)
  var hasSpace = cleaned.indexOf(' ') > -1
  return rawName != cleaned || !hasSpace
}

function sendVerify(params) {
  console.log("sendVerify()... ");
  var template = fs.readFileSync('./template/email_verify.html').toString();

  var url = params.url;
  var name = cleanedName(params.name.trim());
  var to = params.email.trim();
  var subject = params.subject || 'MNP - Confirm Email';

  var message = mustache.render(template, {
    name: name,
    link: url
  });

  var urlLink = `<br/><br/><a href="${url}">${url}</a><br/><br/>`;
  var htmlMessage = mustache.render(template, {
    name: name,
    link: urlLink
  });
  
  if (!util.isBannedEmail(to)) {
    email.send(to, subject, message, htmlMessage);
  }
}

function isString(val) {
  return typeof val === 'string' || ((!!val && typeof val === 'object') && Object.prototype.toString.call(val) === '[object String]');
}

function sendForgotPass(params) {
  console.log("sendForgotPass()... ");
  var template = fs.readFileSync('./template/email_forgotpass.html').toString();

  var url = params.url;
  var name = params.name;
  var to = params.email;
  var subject = params.subject || 'MNP - Reset Password';

  var message = mustache.render(template, {
    name: name,
    link: url
  });

  var urlLink = '<br/><br/><a href="' + url + '">' + url + '</a><br/><br/>';
  var htmlMessage = mustache.render(template, {
    name: name,
    link: urlLink
  });
  if (!util.isBannedEmail(to)) {
    email.send(to, subject, message, htmlMessage);
  }
}

module.exports = {
  makeKey,
  all: getAll,
  //TODO: Should this involve a callback?
  get: getPlayer,
   //TODO: Change to use callback?
  getByEmail: function(email) {
    if(!util.isEmail(email)) return;
    return this.getByField('email',email);
  },
  getByName: function(name) {
    return this.getByField('name',name);
  },
  //TODO: This should be replaced by mongo.findOne
  getByField: function(field,value) {
    console.log('getByField - ' + field + ' / value - ' + value);
    var list = this.all();
    //Names are compared normalized and without regard to case; other fields
    //(email) trimmed and without regard to case.
    var comparable = field == 'name' ? util.nameKey : function(v) { return v.trim().toLowerCase(); };
    var check = comparable(value);
    for(i in list) {
      var p = list[i];
      console.log('i: ' + i, '  p: ' + p + '  p[field]: ' + p[field]);
      if(p[field] && isString(p[field]) && comparable(p[field]) == check) {
        return p;
      }
    }
  },
  login: function(params,callback) {
    var username = params.username;
    var pass = params.pass;

    if(!username || username.length == 0) {
      console.log("login failed, empty playername");
      return callback("ERROR: Failed to login");
    }

    if(!pass || pass.length == 0) {
      console.log("login failed, empty pass");
      return callback("ERROR: Failed to login");
    }

    var player;

    if(username.indexOf('@') >= 0) {
      //Find the ukey to match the email, if possible.
      player = this.getByEmail(username);
    } else {
      player = this.getByName(username);
    }
    
    if(!player) {
      console.log("login failed, unknown player: \"" + username + "\"");
      return callback("ERROR: Failed to login");
    }

    if(!Auth.shadows.check(player.key,pass)) {
      console.log("login failed, incorrect password for player: " + player.key);
      return callback("ERROR: Failed to login");
    }
    console.log("login SUCCESS: " +player.key);

    callback(null, player);
  },
  signup: function(params,callback) {
    var name = util.normalizeName(params.name);
    var email = params.email;
    var answerX = params.answerX;
    var dayOfMonth = new Date().getDate();
    var answerCorrect = getCorrectAnswer();
    if(!util.isEmail(email)) { return callback("ERROR: Invalid Email address. \"" +params.email+ "\""); }

    var player;

    //If we are having users signup with their email, that is probably
    //the only check we should make for a prior user.
    //HOWEVER, We very much do not want to allow duplicate names
    //		so long as we use them as the root of our keys.
    //var player = this.getByName(name);
    //if(!player) player = this.getByEmail(email);
    var player = this.getByEmail(email);
    if(player) console.log("Email already used. verified: " +player.verified);
    var token;

    if (answerX != answerCorrect) {
      console.log("Bogus answer.");
      return callback("Bogus answer");
    } else if (util.isBannedEmail(email) || isBogusName(name)) {
      console.log("Banned email or name.");
      return callback("Banned email or name"); // don't provide any info
    } else if(!player) {
      console.log("Player is unknown, creating new...");
      var key = makeKey(name);
      token = ids.create();

      Auth.tokens.set(key,token);
      player = {
        key: key,
        name: name,
        email: email,
        created_at: Date.now(),
      };
    }
    else {
      console.log("Player object existed already...");
      //, resending verify link...");
      if(player.verified) {
        console.log("Player already verified, sending to existing email...");
      }
      else {
        console.log("Player not yet verified, using the most recent email...");
        player.email = email;
      }
      token = Auth.tokens.get(player.key);
      if(!token) {
        console.log("Token did not exist for " +player.key);
        token = ids.create();
        Auth.tokens.set(player.key, token);
      }
    }
    sendVerify({
      url: params.host + '/verify/' + token,
      name: name,
      email: player.email
    });
    savePlayer(player);
    callback(null, player);
  },
  sendPlayerConduct: function(params,callback) {
    console.log('sendPlayerConduct function called');

    var subject = 'Player Conduct - ' + params.subject;
    var from = params.from.length > 0 ? params.from : 'anonymous';
    var message = 'Reported by: ' + from + '\n\n' + params.message;
  
    email.send('seattlemnp@gmail.com', subject, message, message);
    callback(null, null);
  },
  forgotpass: function(params,callback) {
    console.log('player.forgotpass function called');
    const username = params.username;
    console.log('username: ' + username);

    player = this.getByEmail(username);
    if (!player) {
      player = this.getByName(username);
    }
    if(!player) { 
      return callback("ERROR: No such user: \"" +username+ "\""); 
    }
    console.log('player.name: ' + player.name);
    var token;
    if(!player) {
      console.log("Player is unknown");
    }
    else {
      console.log("Player object exists, sending verify link...");
      token = Auth.tokens.get(player.key);
      if(!token) {
        console.log("Token did not exist for " +player.key);
        token = ids.create();
        Auth.tokens.set(player.key, token);
      }
    }
    sendForgotPass({
      url: params.host + '/forgotpassword/' + token,
      name: player.name,
      email: player.email
    });
    callback(null, player);
  },
  verify: function(params,callback) {
    var token = params.token;
    console.log("verify token: ",token);
    //TODO: Index the tokens if needed.
    //TODO: OR mongo.find('players',{token: token})...

    var ukey = Auth.tokens.keyFor(token);
    if(!ukey) {
      return callback("ERROR: No token found: " +token);
    }

    //var player = this.getByField('token',token);
    var player = this.get(ukey);
    if(!player) {
      return callback("ERROR: No player matches token " +token);
    }
    player.verified = true;
    savePlayer(player);
    callback(null, player);
  },
  createPass: function(params,callback) {
    if(!passesMatch(params)) { return callback("ERR: Passwords did not match"); }
    var player = this.get(params.ukey);
    if(!player) { return callback("ERR: Player not found for " +params.ukey); }
    Auth.shadows.put(player.key, params.pass);
    console.log("Password set for: " +player.key);
    callback(null,player);
  },
  destroy: destroyPlayer,
  getQuestion: getQuestion
};
