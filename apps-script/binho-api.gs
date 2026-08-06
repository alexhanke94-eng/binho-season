/**
 * Binho League API — the backend for the season tracker.
 *
 * The Google Sheet is the database. This script is the only thing that writes to it,
 * so permissions are enforced here, on Google's side, where a browser cannot skip them.
 *
 * ROLES
 *   guest   — no sign-in. Read everything, record a match, set a player photo.
 *   manager — roster, membership, settings, delete a logged match.
 *   admin   — everything above plus ending a season, erasing data, and setting passcodes.
 *
 * INSTALL
 *   1. Open the season workbook > Extensions > Apps Script. Paste this file in. Save.
 *   2. Run setup() once from the editor and authorize it. The execution log prints your
 *      first admin passcode and a recovery code — copy both, they are shown once.
 *   3. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
 *   4. Copy the /exec URL into config.js in the web app repo.
 *
 * WHY "Anyone" IS STILL SAFE
 *   The URL only grants what a guest may do: read the league and record a game.
 *   Roster, season, and passcode changes require a token this script issues after a
 *   successful sign-in, so holding the URL is not the same as holding the keys.
 */

var LOG_SHEET     = 'Log';
var DISCARD_SHEET = 'Discarded';   // kept records that count for nothing — physically out of Log
var STATE_SHEET   = 'State';
var PHOTO_SHEET   = 'Photos';
var TOKEN_HOURS   = 12;

var HEADERS = ['MatchID','Date','Type','Home','Away','HomeGoals','AwayGoals','Winner','SuddenDeath',
  'CleanSheet','Mode','BeltMatch','Official','HomeY','HomeR','HomeSecondYellowReds','HomeTech',
  'HomeOwnGoals','HomePegsLost','AwayY','AwayR','AwaySecondYellowReds','AwayTech','AwayOwnGoals',
  'AwayPegsLost','HomeHatTricks','AwayHatTricks','HomePowerUp','AwayPowerUp','HomeEvent','AwayEvent','MVPPiece',
  'Time','Edited'];   // appended last on purpose: Standings/Standard formulas reference columns by position

/* ============================ setup ============================ */

function setup(){
  var props = PropertiesService.getScriptProperties();
  if(!props.getProperty('salt')) props.setProperty('salt', Utilities.getUuid());

  var admin = randomCode_(3);
  var recovery = randomCode_(4);
  props.setProperty('adminHash', hash_(admin));
  props.setProperty('recoveryHash', hash_(recovery));

  getLogSheet_();
  getStateSheet_();
  getPhotoSheet_();

  Logger.log('=========================================');
  Logger.log('ADMIN PASSCODE : ' + admin);
  Logger.log('RECOVERY CODE  : ' + recovery);
  Logger.log('Copy both now — they are not stored in readable form.');
  Logger.log('Change the admin passcode from the app once you are signed in.');
  Logger.log('=========================================');
}

/* ============================ routing ============================ */

function doPost(e){
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var action = body.action || '';
    // Reads never take the lock, so they stop queueing behind writes.
    if(action === 'state' || action === 'photos'){
      return json_(route_(body));
    }
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(25000);
      var out = route_(body);
      invalidateState_();   // a write may have changed things — drop the cached state
      return json_(out);
    } finally {
      try { lock.releaseLock(); } catch (ignore) {}
    }
  } catch (err) {
    return json_({ ok:false, error:String(err) });
  }
}

function doGet(){
  return json_({ ok:true, message:'Binho League API is live. Post an action to use it.' });
}

function route_(body){
  var action = body.action || '';

  switch(action){
    case 'state':       return { ok:true, state: cachedState_() };
    case 'photos':      return { ok:true, photos: readPhotos_() };   // full map, pulled only when photoVersion changes
    case 'login':       return login_(body.code);
    case 'logout':      return logout_(body.token);
    case 'match':       return recordMatch_(body.match);          // guest
    case 'photo':       return savePhoto_(body.name, body.image); // guest
    case 'deleteMatch': return needs_(body.token, 'manager', function(){ return deleteMatch_(body.id); });
    case 'updateMatch': return body.op === 'discard'
      ? updateMatch_(body.match, 'discard')                                                    // anyone may discard
      : needs_(body.token, 'manager', function(){ return updateMatch_(body.match, body.op); }); // edit / restore
    case 'roster':      return needs_(body.token, 'manager', function(){ return saveRoster_(body.players, body.members); });
    case 'settings':    return needs_(body.token, 'manager', function(){ return saveSettings_(body.cfg); });
    case 'season':      return needs_(body.token, 'admin',   function(){ return endSeason_(body.name, body.champion, body.table); });
    case 'wipe':        return needs_(body.token, 'admin',   function(){ return wipe_(); });
    case 'passcode':    return needs_(body.token, 'admin',   function(){ return setPasscode_(body.which, body.code); });
    default:            return { ok:false, error:'Unknown action: ' + action };
  }
}

/* ============================ auth ============================ */

function login_(code){
  if(!code) return { ok:false, error:'No passcode supplied' };
  var props = PropertiesService.getScriptProperties();
  var h = hash_(String(code).trim());

  if(h === props.getProperty('adminHash'))   return { ok:true, role:'admin',   token: issue_('admin') };
  if(h === props.getProperty('managerHash')) return { ok:true, role:'manager', token: issue_('manager') };

  if(h === props.getProperty('recoveryHash')){
    // recovery signs you in as admin and hands back a fresh pair
    var nextAdmin = randomCode_(3);
    var nextRecovery = randomCode_(4);
    props.setProperty('adminHash', hash_(nextAdmin));
    props.setProperty('recoveryHash', hash_(nextRecovery));
    return { ok:true, role:'admin', token: issue_('admin'), newAdmin: nextAdmin, newRecovery: nextRecovery };
  }

  Utilities.sleep(600);   // slows down anyone trying codes in bulk
  return { ok:false, error:'Passcode not recognised' };
}

function logout_(token){
  if(token) PropertiesService.getScriptProperties().deleteProperty('tok_' + token);
  return { ok:true };
}

function issue_(role){
  var token = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty('tok_' + token, JSON.stringify({
    role: role,
    exp: Date.now() + TOKEN_HOURS * 3600 * 1000
  }));
  return token;
}

function roleOf_(token){
  if(!token) return 'guest';
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('tok_' + token);
  if(!raw) return 'guest';
  var t = JSON.parse(raw);
  if(Date.now() > t.exp){ props.deleteProperty('tok_' + token); return 'guest'; }
  return t.role;
}

function needs_(token, level, fn){
  var role = roleOf_(token);
  var rank = { guest:0, manager:1, admin:2 };
  if(rank[role] < rank[level]){
    return { ok:false, error:'Needs ' + level + ' access. Sign in again if your session expired.' };
  }
  return fn();
}

function setPasscode_(which, code){
  var props = PropertiesService.getScriptProperties();
  if(which === 'manager'){
    if(!code){ props.deleteProperty('managerHash'); return { ok:true, removed:true }; }
    props.setProperty('managerHash', hash_(String(code).trim()));
    return { ok:true };
  }
  if(which === 'admin'){
    if(!code || String(code).trim().length < 6) return { ok:false, error:'Admin passcode needs at least six characters' };
    props.setProperty('adminHash', hash_(String(code).trim()));
    return { ok:true };
  }
  if(which === 'recovery'){
    var fresh = randomCode_(4);
    props.setProperty('recoveryHash', hash_(fresh));
    return { ok:true, recovery: fresh };
  }
  return { ok:false, error:'Unknown passcode type' };
}

function hash_(str){
  var salt = PropertiesService.getScriptProperties().getProperty('salt') || '';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + str, Utilities.Charset.UTF_8);
  return bytes.map(function(b){ return ((b & 0xFF) + 0x100).toString(16).slice(1); }).join('');
}

function randomCode_(blocks){
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', out = [];
  for(var g = 0; g < blocks; g++){
    var s = '';
    for(var i = 0; i < 4; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    out.push(s);
  }
  return out.join('-');
}

/* ============================ state ============================ */

function blankState_(){
  return {
    players: [], members: [], belt: null, archives: [],
    cfg: { winPts:3, csPts:1, clockMin:5, scoreLimit:7, sdScore:5, req:20,
           countdown:3, voice:true, seasonName:'' }
  };
}

var STATE_CACHE_KEY = 'state_v2';
var STATE_CACHE_SEC = 15;

// A burst of reads hits the sheet once and everyone else gets the cached copy.
function cachedState_(){
  var cache = CacheService.getScriptCache();
  var hit = cache.get(STATE_CACHE_KEY);
  if(hit){ try { return JSON.parse(hit); } catch(ignore){} }
  var state = readState_();
  try { cache.put(STATE_CACHE_KEY, JSON.stringify(state), STATE_CACHE_SEC); } catch(ignore){}
  return state;
}

function invalidateState_(){
  try { CacheService.getScriptCache().remove(STATE_CACHE_KEY); } catch(ignore){}
}

function readState_(){
  var sheet = getStateSheet_();
  var raw = sheet.getRange('A1').getValue();
  var state = raw ? JSON.parse(raw) : blankState_();
  state.matches = readMatches_();
  state.photoVersion = photoVersion_();   // the photos themselves come from the 'photos' action
  state.hasManager = !!PropertiesService.getScriptProperties().getProperty('managerHash');
  return state;
}

// A short fingerprint of the photo set — player name plus image length — so the client
// can tell when any photo changed without pulling the images on every state read.
function photoVersion_(){
  var rows = getPhotoSheet_().getDataRange().getValues();
  var parts = [];
  rows.forEach(function(r){ if(r[0]) parts.push(r[0] + ':' + String(r[1] == null ? '' : r[1]).length); });
  if(!parts.length) return '0';
  parts.sort();
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, parts.join('|'), Utilities.Charset.UTF_8);
  return digest.map(function(b){ return ((b & 0xFF) + 0x100).toString(16).slice(1); }).join('').slice(0, 12);
}

function writeState_(state){
  var copy = JSON.parse(JSON.stringify(state));
  delete copy.matches;        // matches live in the Log sheet
  delete copy.photos;         // photos live in the Photos sheet
  delete copy.photoVersion;   // derived, never stored
  delete copy.hasManager;
  getStateSheet_().getRange('A1').setValue(JSON.stringify(copy));
}

function saveRoster_(players, members){
  var state = readState_();
  state.players = players || [];
  state.members = members || [];
  writeState_(state);
  return { ok:true, state: readState_() };
}

function saveSettings_(cfg){
  var state = readState_();
  var allowed = ['winPts','csPts','clockMin','scoreLimit','sdScore','req','countdown','voice','seasonName'];
  allowed.forEach(function(k){ if(cfg && cfg.hasOwnProperty(k)) state.cfg[k] = cfg[k]; });
  writeState_(state);
  return { ok:true, state: readState_() };
}

function endSeason_(name, champion, table){
  var state = readState_();
  var league = readMatches_().filter(function(m){ return m.type !== 'standard' && !m.discarded; });

  state.archives = state.archives || [];
  state.archives.unshift({
    name: name || state.cfg.seasonName || 'Season',
    closed: Date.now(),
    champion: champion || '',
    table: table || [],
    games: league.length
  });
  state.cfg.seasonName = '';
  writeState_(state);

  // archive the rows, then leave standard play in place
  var sheet = getLogSheet_();
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var archive = SpreadsheetApp.getActiveSpreadsheet().insertSheet('Season ' + stamp + ' ' + Math.floor(Math.random()*90+10));
  archive.appendRow(HEADERS);

  var rows = sheet.getDataRange().getValues();
  var keep = [HEADERS];
  for(var i = 1; i < rows.length; i++){
    if(String(rows[i][2]) === 'Standard') keep.push(rows[i]);
    else archive.appendRow(rows[i]);
  }
  sheet.clear();
  sheet.getRange(1, 1, keep.length, HEADERS.length).setValues(keep);
  sheet.setFrozenRows(1);

  return { ok:true, state: readState_() };
}

function wipe_(){
  writeState_(blankState_());
  [getLogSheet_(), getDiscardSheet_()].forEach(function(sheet){
    sheet.clear();
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  });
  getPhotoSheet_().clear();
  return { ok:true, state: readState_() };
}

/* ============================ matches ============================ */

function recordMatch_(m){
  if(!m || !m.home || !m.away) return { ok:false, error:'Match is missing players' };
  var sheet = getLogSheet_();

  var last = sheet.getLastRow();
  if(last > 1){
    var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
    for(var i = 0; i < ids.length; i++){
      if(ids[i][0] === m.id) return { ok:true, duplicate:true, state: readState_() };
    }
  }

  sheet.appendRow(matchToRow_(m));
  recomputeBelt_();
  return { ok:true, state: readState_() };
}

function deleteMatch_(id){
  var sheet = getLogSheet_();
  var rows = sheet.getDataRange().getValues();
  for(var i = rows.length - 1; i >= 1; i--){
    if(rows[i][0] === id){ sheet.deleteRow(i + 1); break; }
  }
  recomputeBelt_();
  return { ok:true, state: readState_() };
}

// One action for edit, discard and restore so the rules stay in one place.
//   edit    — replace the row in place, wherever it lives
//   discard — move it into the Discarded sheet, out of Log so no formula sees it
//   restore — move it back into the Log sheet
function updateMatch_(m, op){
  if(!m || !m.id) return { ok:false, error:'No match id supplied' };
  op = op || 'edit';
  var log = getLogSheet_(), disc = getDiscardSheet_(), row = matchToRow_(m);

  if(op === 'discard'){
    removeRow_(log, m.id);
    putRow_(disc, m.id, row);
  } else if(op === 'restore'){
    removeRow_(disc, m.id);
    putRow_(log, m.id, row);
  } else {
    if(findRow_(log, m.id) > 0) putRow_(log, m.id, row);
    else if(findRow_(disc, m.id) > 0) putRow_(disc, m.id, row);
    else return { ok:false, error:'That match is not on file (unknown MatchID)' };
  }
  recomputeBelt_();
  return { ok:true, state: readState_() };
}

function findRow_(sheet, id){
  var last = sheet.getLastRow();
  if(last < 2) return -1;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for(var i = 0; i < ids.length; i++){ if(ids[i][0] === id) return i + 2; }
  return -1;
}
function removeRow_(sheet, id){ var r = findRow_(sheet, id); if(r > 0) sheet.deleteRow(r); }
function putRow_(sheet, id, row){
  var r = findRow_(sheet, id);
  if(r > 0) sheet.getRange(r, 1, 1, row.length).setValues([row]);
  else sheet.appendRow(row);
}

// The belt is held by the winner of the most recent belt league match still in the Log.
// Discarded games live in their own sheet, so they can never hold the belt.
function recomputeBelt_(){
  var matches = readMatchRows_(getLogSheet_()).sort(function(a, b){ return b.ts - a.ts; });
  var belt = null;
  for(var i = 0; i < matches.length; i++){
    var m = matches[i];
    if(m.belt && m.type !== 'standard' && m.sh !== m.sa){
      belt = { holder: m.sh > m.sa ? m.home : m.away, since: m.ts };
      break;
    }
  }
  var state = readState_();
  state.belt = belt;
  writeState_(state);
}

function matchToRow_(m){
  var standard = m.type === 'standard';
  var sh = num_(m.sh), sa = num_(m.sa);
  var winner = sh > sa ? m.home : (sa > sh ? m.away : '');
  return [
    m.id, formatDate_(m.ts), standard ? 'Standard' : 'League', m.home, m.away, sh, sa, winner,
    m.sd ? 'Yes' : 'No', Math.min(sh, sa) === 0 ? 'Yes' : 'No',
    m.mode || 'Standard', m.belt ? 'Yes' : 'No', m.official ? 'Yes' : 'No',
    num_(m.yH), num_(m.rH), num_(m.syH), num_(m.tH), num_(m.ogH), num_(m.rH) + (standard ? 0 : num_(m.ogH)),
    num_(m.yA), num_(m.rA), num_(m.syA), num_(m.tA), num_(m.ogA), num_(m.rA) + (standard ? 0 : num_(m.ogA)),
    num_(m.htH), num_(m.htA),
    m.puH || '', m.puA || '', m.ecH || '', m.ecA || '', m.mvp || '',
    formatTime_(m.ts), m.edited ? 'Yes' : ''
  ];
}

function rowToMatch_(r){
  return {
    id: r[0], ts: dateToTs_(r[1], r[32]), type: r[2] === 'Standard' ? 'standard' : 'league',
    home: r[3], away: r[4], sh: num_(r[5]), sa: num_(r[6]),
    sd: r[8] === 'Yes', mode: r[10], belt: r[11] === 'Yes', official: r[12] === 'Yes',
    yH: num_(r[13]), rH: num_(r[14]), syH: num_(r[15]), tH: num_(r[16]), ogH: num_(r[17]),
    yA: num_(r[19]), rA: num_(r[20]), syA: num_(r[21]), tA: num_(r[22]), ogA: num_(r[23]),
    htH: num_(r[25]), htA: num_(r[26]),
    puH: r[27], puA: r[28], ecH: r[29], ecA: r[30], mvp: r[31],
    edited: r[33] === 'Yes'
  };
}

function readMatchRows_(sheet){
  var rows = sheet.getDataRange().getValues();
  var out = [];
  for(var i = 1; i < rows.length; i++){ if(rows[i][0]) out.push(rowToMatch_(rows[i])); }
  return out;
}

// Log rows as normal, plus Discarded rows flagged so the app can show them apart.
function readMatches_(){
  var log = readMatchRows_(getLogSheet_());
  var disc = readMatchRows_(getDiscardSheet_());
  for(var i = 0; i < disc.length; i++) disc[i].discarded = true;
  return log.concat(disc).sort(function(a, b){ return b.ts - a.ts; });
}

/* ============================ photos ============================ */

function savePhoto_(name, image){
  if(!name || !image) return { ok:false, error:'Photo needs a player and an image' };
  if(String(image).length > 45000) return { ok:false, error:'Photo is too large' };
  var sheet = getPhotoSheet_();
  var rows = sheet.getDataRange().getValues();
  for(var i = 0; i < rows.length; i++){
    if(rows[i][0] === name){ sheet.getRange(i + 1, 2).setValue(image); return { ok:true }; }
  }
  sheet.appendRow([name, image]);
  return { ok:true };
}

function readPhotos_(){
  var rows = getPhotoSheet_().getDataRange().getValues();
  var out = {};
  rows.forEach(function(r){ if(r[0]) out[r[0]] = r[1]; });
  return out;
}

/* ============================ plumbing ============================ */

// Make sure row 1 has every header, appending any missing ones to the end so existing
// column positions never shift (the workbook's formulas depend on them).
function ensureHeaders_(sheet){
  if(sheet.getLastRow() === 0){ sheet.appendRow(HEADERS); sheet.setFrozenRows(1); return; }
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  HEADERS.forEach(function(h){
    if(header.indexOf(h) === -1){ sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h); header.push(h); }
  });
}

function getLogSheet_(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET) || ss.insertSheet(LOG_SHEET);
  ensureHeaders_(sheet);
  return sheet;
}

function getDiscardSheet_(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(DISCARD_SHEET) || ss.insertSheet(DISCARD_SHEET);
  ensureHeaders_(sheet);
  return sheet;
}

function getStateSheet_(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(STATE_SHEET);
  if(!sheet){
    sheet = ss.insertSheet(STATE_SHEET);
    sheet.getRange('A1').setValue(JSON.stringify(blankState_()));
    sheet.hideSheet();
  }
  return sheet;
}

function getPhotoSheet_(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PHOTO_SHEET);
  if(!sheet){ sheet = ss.insertSheet(PHOTO_SHEET); sheet.hideSheet(); }
  return sheet;
}

function json_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function num_(v){ return typeof v === 'number' ? v : (parseInt(v, 10) || 0); }

function formatDate_(ts){
  var d = ts ? new Date(ts) : new Date();
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function formatTime_(ts){
  var d = ts ? new Date(ts) : new Date();
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'HH:mm:ss');
}

// Combine the Date cell with the (optional) Time cell into an accurate timestamp. Cells can
// come back as strings or, if Sheets auto-formatted them, as Date objects — handle both.
// Rows with no time (everything logged before the Time column existed) fall back to noon.
function dateToTs_(dateVal, timeVal){
  var tz = Session.getScriptTimeZone();
  var dateStr = dateVal instanceof Date ? Utilities.formatDate(dateVal, tz, 'yyyy-MM-dd') : String(dateVal || '');
  var timeStr = timeVal instanceof Date ? Utilities.formatDate(timeVal, tz, 'HH:mm:ss') : String(timeVal || '');
  if(!/^\d{1,2}:\d{2}/.test(timeStr)) timeStr = '12:00:00';   // missing/invalid time → noon, as before
  var d = new Date(dateStr + 'T' + timeStr);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

/* ============================ self test ============================ */

/** Run this from the editor to prove the whole chain works, then check the Log tab. */
function selfTest(){
  var res = route_({ action:'state' });
  Logger.log('state ok: ' + res.ok + ' — players: ' + res.state.players.length + ', matches: ' + res.state.matches.length);

  var bad = route_({ action:'roster', token:'not-a-real-token', players:['Hacker'], members:['Hacker'] });
  Logger.log('roster without a token: ' + JSON.stringify(bad));   // expect ok:false

  var m = route_({ action:'match', match:{
    id:'selftest-' + Date.now(), ts:Date.now(), type:'league', home:'Test A', away:'Test B',
    sh:7, sa:3, sd:false, mode:'Standard', belt:false, official:false,
    yH:1, rH:0, syH:0, tH:0, ogH:0, yA:2, rA:1, syA:1, tA:0, ogA:1,
    htH:1, htA:0, puH:'Freeze', puA:'Rewind', ecH:'Rain Delay', ecA:'Extra Time', mvp:'test peg'
  }});
  Logger.log('guest recorded a match: ' + m.ok + ' — now ' + m.state.matches.length + ' on file');
  Logger.log('Delete the Test A / Test B row from the Log tab when you are done.');
}
