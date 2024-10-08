var fs = require('fs');
var CONST = require('../constants');
var express = require('express');
var mustache = require('mustache');
var router = express.Router();
const config = require('../config');

var machines = require('../model/machines');

var base = fs.readFileSync('./template/base.html').toString();

router.get('/machines',function(req,res) {
  var template = fs.readFileSync('./template/machines.html').toString();
  var ukey = req.user.key || 'ANON';

  let isLeagueAdmin = !!config.LEAGUE_ADMINS.find(k => k === ukey);
  
  var canAdd = (CONST.ROOT == ukey || isLeagueAdmin);
  var canRemove = (CONST.ROOT == ukey || isLeagueAdmin);
  var list = machines.all();

  console.log('# machines:',list.length);

  list.sort(function(a,b) {
    if(a.name == b.name) return 0;
    var check = [a.name, b.name];
    check.sort();
    if(check[0] == a.name) return -1;
    return 1;
  });

  var html = mustache.render(base, {
    title: 'Machines',
    machines: list,
    canAdd: canAdd,
    canRemove: canRemove
  }, {
    content: template
  });

  res.send(html);
});

router.post('/machines',function(req,res) {
  var ukey = req.user.key;
  let isLeagueAdmin = !!config.LEAGUE_ADMINS.find(k => k === ukey);
  if (CONST.ROOT == ukey || isLeagueAdmin) {
    machines.add({
      key: req.body.mkey,
      name: req.body.name
    });

    var check = machines.get(req.body.mkey);
    console.log('check:',check);
  }

  res.redirect('/machines');
});

router.post('/machines/:machine_key/remove',function(req,res) {
  var ukey = req.user.key;
  let isLeagueAdmin = !!config.LEAGUE_ADMINS.find(k => k === ukey);
  if (CONST.ROOT == ukey || isLeagueAdmin) {
    machines.remove({
      key: req.body.mkey
    });

    var check = machines.get(req.body.mkey);
    console.log('check:',check);
  }

  res.redirect('/machines');
});

module.exports = router;
