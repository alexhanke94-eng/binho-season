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
var TOURN_SHEET   = 'Tournaments'; // one row per tournament, JSON in a cell
var STATE_SHEET   = 'State';
var PHOTO_SHEET   = 'Photos';
var TOKEN_HOURS   = 12;

var HEADERS = ['MatchID','Date','Type','Home','Away','HomeGoals','AwayGoals','Winner','SuddenDeath',
  'CleanSheet','Mode','BeltMatch','Official','HomeY','HomeR','HomeSecondYellowReds','HomeTech',
  'HomeOwnGoals','HomePegsLost','AwayY','AwayR','AwaySecondYellowReds','AwayTech','AwayOwnGoals',
  'AwayPegsLost','HomeHatTricks','AwayHatTricks','HomePowerUp','AwayPowerUp','HomeEvent','AwayEvent','MVPPiece',
  'Time','Edited','Tournament','HomeMembers','AwayMembers'];   // appended last on purpose: Standings/Standard formulas reference columns by position

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
    case 'createTournament': return needs_(body.token, 'manager', function(){ return createTournament_(body.tournament); });
    case 'updateTournament': return (body.op === 'result' || body.op === 'splitThird')
      ? updateTournament_(body.id, body.op, body.payload, { code: body.code, token: body.token })   // guest, but must have joined
      : needs_(body.token, 'manager', function(){ return updateTournament_(body.id, body.op, body.payload, { token: body.token }); }); // edit/void/reopen/reset/markPaid/regenCode/setThird
    case 'claimMatch':   return claimMatch_(body.id, body.matchId, body.clientId, { code: body.code, token: body.token });   // guest — under the lock, so atomic
    case 'releaseMatch': return needs_(body.token, 'manager', function(){ return releaseMatch_(body.id, body.matchId); });
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

// A short tournament join code, five characters from the same unambiguous alphabet (no O/0,
// no I/1) so it reads cleanly across a room. Kept clear of codes already in play.
var JOIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function joinCode_(){
  var s = '';
  for(var i = 0; i < 5; i++) s += JOIN_ALPHABET.charAt(Math.floor(Math.random() * JOIN_ALPHABET.length));
  return s;
}
function uniqueJoinCode_(taken){
  var code, guard = 0;
  do { code = joinCode_(); } while(taken[code] && ++guard < 50);
  return code;
}
// codes currently held by other tournaments, so a new or regenerated one never collides
function takenCodes_(exceptId){
  var out = {};
  readTournaments_().forEach(function(t){ if(t.code && t.id !== exceptId) out[String(t.code).toUpperCase()] = 1; });
  return out;
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
  state.tournaments = readTournaments_();
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
  delete copy.tournaments;    // tournaments live in the Tournaments sheet
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
  getTournSheet_().clear();
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
    formatTime_(m.ts), m.edited ? 'Yes' : '', m.tournament || '',
    membersCell_(m.homeMembers), membersCell_(m.awayMembers)
  ];
}

// team/duo member lists ride the Log as comma-separated names; empty for singles. Accept an
// array or an already-joined string so re-writing an edited row never mangles them.
function membersCell_(v){ return Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v)); }
function splitMembers_(v){ return v ? String(v).split(/\s*,\s*/).filter(function(x){ return x; }) : []; }

function rowToMatch_(r){
  return {
    id: r[0], ts: dateToTs_(r[1], r[32]), type: r[2] === 'Standard' ? 'standard' : 'league',
    home: r[3], away: r[4], sh: num_(r[5]), sa: num_(r[6]),
    sd: r[8] === 'Yes', mode: r[10], belt: r[11] === 'Yes', official: r[12] === 'Yes',
    yH: num_(r[13]), rH: num_(r[14]), syH: num_(r[15]), tH: num_(r[16]), ogH: num_(r[17]),
    yA: num_(r[19]), rA: num_(r[20]), syA: num_(r[21]), tA: num_(r[22]), ogA: num_(r[23]),
    htH: num_(r[25]), htA: num_(r[26]),
    puH: r[27], puA: r[28], ecH: r[29], ecA: r[30], mvp: r[31],
    edited: r[33] === 'Yes', tournament: r[34] || '',
    homeMembers: splitMembers_(r[35]), awayMembers: splitMembers_(r[36])
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

/* ============================ tournaments ============================ */

var CLAIM_TTL_MS = 45 * 60 * 1000;   // a claim older than this returns to the queue (a phone died mid-match)

function getTournSheet_(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TOURN_SHEET);
  if(!sheet){ sheet = ss.insertSheet(TOURN_SHEET); sheet.appendRow(['id','status','updated','json']); sheet.setFrozenRows(1); sheet.hideSheet(); }
  return sheet;
}

function readTournaments_(){
  var rows = getTournSheet_().getDataRange().getValues();
  var out = [];
  for(var i = 1; i < rows.length; i++){
    if(!rows[i][0]) continue;
    try { out.push(JSON.parse(rows[i][3])); } catch(e){}
  }
  return out;
}

function tournRow_(sheet, id){
  var last = sheet.getLastRow();
  if(last < 2) return -1;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for(var i = 0; i < ids.length; i++){ if(ids[i][0] === id) return i + 2; }
  return -1;
}

function writeTournament_(t){
  var sheet = getTournSheet_();
  var row = [t.id, t.status || 'active', Date.now(), JSON.stringify(t)];
  var r = tournRow_(sheet, t.id);
  if(r > 0) sheet.getRange(r, 1, 1, row.length).setValues([row]);
  else sheet.appendRow(row);
}

function loadTournament_(id){
  var sheet = getTournSheet_();
  var r = tournRow_(sheet, id);
  if(r < 0) return null;
  try { return JSON.parse(sheet.getRange(r, 4).getValue()); } catch(e){ return null; }
}

function deleteTournament_(id){
  var sheet = getTournSheet_();
  var r = tournRow_(sheet, id);
  if(r > 0) sheet.deleteRow(r);
}

function createTournament_(t){
  if(!t || !t.id || !t.name) return { ok:false, error:'Tournament is missing a name' };
  if(!t.rounds || !t.rounds.length) return { ok:false, error:'Tournament has no bracket' };
  t.status = 'active';
  t.created = t.created || Date.now();
  // The join code is authoritative here: honour a clash-free client suggestion, otherwise mint one.
  var taken = takenCodes_(t.id);
  var suggested = t.code ? String(t.code).toUpperCase() : '';
  t.code = (suggested && /^[A-Z0-9]{4,6}$/.test(suggested) && !taken[suggested]) ? suggested : uniqueJoinCode_(taken);
  writeTournament_(t);
  return { ok:true, state: readState_() };
}

// find a match anywhere in the bracket by its id — the third-place playoff included, so it is
// claimed, played and reported through exactly the same code as any other cup match.
function tMatch_(t, matchId){
  for(var r = 0; r < t.rounds.length; r++){
    for(var i = 0; i < t.rounds[r].length; i++){ if(t.rounds[r][i].id === matchId) return t.rounds[r][i]; }
  }
  if(t.thirdPlace && !t.thirdPlace.split && t.thirdPlace.id === matchId) return t.thirdPlace;
  return null;
}

// Recompute every fed slot from its feeders' winners. Setting a slot from a winner AND
// clearing it when the feeder has no winner keeps the bracket correct when a result is
// changed, discarded, or reopened — not just when one is first reported. Round 0 is seeded
// directly from the entrants, so it is never recomputed.
function tFeedForward_(t){
  for(var r = 1; r < t.rounds.length; r++){
    t.rounds[r].forEach(function(m){
      var f1 = t.rounds[r - 1][m.index * 2], f2 = t.rounds[r - 1][m.index * 2 + 1];
      m.a = f1.winner || null;
      m.b = f2.winner || null;
    });
  }
}

// the match a given match feeds into, or null if it is the final (or the third-place playoff,
// whose winner advances nowhere)
function tDownstream_(t, m){
  if(m.thirdPlace) return null;
  if(m.round >= t.rounds.length - 1) return null;
  return t.rounds[m.round + 1][Math.floor(m.index / 2)];
}

// set or clear the champion/done state from the final, wherever the bracket now stands
function recomputeChampion_(t){
  var last = t.rounds[t.rounds.length - 1][0];
  if(last && last.played && last.winner){
    if(t.status !== 'done') t.closed = Date.now();
    t.status = 'done'; t.champion = last.winner;
  } else {
    t.status = 'active'; t.champion = null; t.closed = null;
  }
}

/* ---- third-place playoff ---- */
// The two matches that feed the final. Their losers contest third place. Only meaningful with
// four or more entrants (fewer means a bye sits in the semifinal round — no real third place).
function tSemis_(t){
  if((t.entrants || []).length < 4 || t.rounds.length < 2) return null;
  var semis = t.rounds[t.rounds.length - 2];
  return (semis && semis.length === 2) ? semis : null;
}
function tLoser_(m){ return m.winner === m.a ? m.b : m.a; }
function tThirdPair_(tp){ return tp.split ? (tp.tied || []) : [tp.a, tp.b]; }
function tSamePair_(p, q){ return p && q && ((p[0] === q[0] && p[1] === q[1]) || (p[0] === q[1] && p[1] === q[0])); }
function tThirdResolved_(t){ return !!(t.thirdPlace && (t.thirdPlace.played || t.thirdPlace.split)); }
function tIsSemi_(t, m){ var s = tSemis_(t); return !!(s && (s[0].id === m.id || s[1].id === m.id)); }
// a played (non-split) third-place result has a Log row; drop it when the match is invalidated
function tThirdDiscardLog_(t){
  var tp = t.thirdPlace;
  if(tp && tp.played && !tp.split && tp.a && tp.b) tMoveLogToDiscard_(t.name, tp.a, tp.b);
}

// Recompute the third-place playoff from the current semifinals — the same feed-from-source idea
// as tFeedForward_. Creates the pending match when both semis are in (setting on) or a tied-third
// split (setting off); keeps an already-resolved result while its two entrants still hold; and
// clears it (discarding any Log row) the moment a semifinal changes or is reopened.
function tThirdPlace_(t){
  var semis = tSemis_(t);
  var ready = semis && semis[0].played && !semis[0].bye && semis[0].winner &&
                       semis[1].played && !semis[1].bye && semis[1].winner;
  if(!ready){ if(t.thirdPlace){ tThirdDiscardLog_(t); t.thirdPlace = null; } return; }
  var losers = [tLoser_(semis[0]), tLoser_(semis[1])];
  var tp = t.thirdPlace;
  if(tp && (tp.played || tp.split) && tSamePair_(tThirdPair_(tp), losers)) return;   // resolved, same pair — keep
  if(tp && tp.played && !tSamePair_([tp.a, tp.b], losers)) tThirdDiscardLog_(t);      // stale played result — drop its row
  if(t.thirdEnabled){
    if(tp && !tp.played && !tp.split && tSamePair_([tp.a, tp.b], losers)){ tp.a = losers[0]; tp.b = losers[1]; return; }   // keep the pending match (and its claim)
    t.thirdPlace = { id: t.id + '-3p', thirdPlace: true, a: losers[0], b: losers[1], winner: null, sh: null, sa: null, played: false, bye: false, claim: null, split: false };
  } else {
    t.thirdPlace = { thirdPlace: true, split: true, tied: losers };   // setting says skip → tied for third
  }
}

// keep the Past-seasons archive entry in step with the tournament's state
function syncTournamentArchive_(t){
  var state = readState_();
  state.archives = state.archives || [];
  var idx = -1;
  for(var i = 0; i < state.archives.length; i++){ if(state.archives[i].tournamentId === t.id){ idx = i; break; } }
  if(t.status === 'done' && t.champion){
    var games = 0;
    t.rounds.forEach(function(rd){ rd.forEach(function(m){ if(m.played && !m.bye) games++; }); });
    if(t.thirdPlace && t.thirdPlace.played) games++;
    var entry = { name: t.name, tournamentId: t.id, type: 'tournament', closed: t.closed || Date.now(),
      champion: t.champion, games: games, entrants: (t.entrants || []).length };
    if(idx >= 0) state.archives[idx] = entry; else state.archives.unshift(entry);
  } else if(idx >= 0){ state.archives.splice(idx, 1); }
  writeState_(state);
}

// move a played cup match's Log row to Discarded, matched by cup name + the two entrants
function tMoveLogToDiscard_(cup, a, b){
  var log = getLogSheet_();
  var rows = log.getDataRange().getValues();
  for(var i = rows.length - 1; i >= 1; i--){
    var r = rows[i];
    if(String(r[34]) === cup && ((r[3] === a && r[4] === b) || (r[3] === b && r[4] === a))){
      getDiscardSheet_().appendRow(r);
      log.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

// board number -> matchId, for claims that are live (not played, not expired)
function tActiveClaims_(t){
  var now = Date.now(), used = {};
  function note(m){ if(m && m.claim && !m.played && (now - m.claim.at) < CLAIM_TTL_MS) used[m.claim.board] = m.id; }
  for(var r = 0; r < t.rounds.length; r++){ t.rounds[r].forEach(note); }
  if(t.thirdPlace && !t.thirdPlace.split) note(t.thirdPlace);
  return used;
}

// A device may act on a tournament if it holds the join code, or if it is a signed-in
// manager/admin (who can run any tournament without joining).
function tournamentAuthed_(t, ctx){
  ctx = ctx || {};
  var rank = { guest:0, manager:1, admin:2 };
  if(rank[roleOf_(ctx.token)] >= 1) return true;
  return !!(ctx.code && t.code && String(ctx.code).toUpperCase() === String(t.code).toUpperCase());
}
var JOIN_REFUSAL = 'Join this tournament first — enter its code on the New match page.';

function claimMatch_(id, matchId, clientId, ctx){
  var t = loadTournament_(id);
  if(!t) return { ok:false, error:'That tournament is not on file' };
  if(!tournamentAuthed_(t, ctx)) return { ok:false, error:JOIN_REFUSAL };
  var m = tMatch_(t, matchId);
  if(!m) return { ok:false, error:'That match is not in the bracket' };
  if(m.played) return { ok:false, error:'That match is already finished' };
  if(!m.a || !m.b) return { ok:false, error:'That match is not ready yet' };
  var now = Date.now();
  if(m.claim && (now - m.claim.at) < CLAIM_TTL_MS && m.claim.by !== clientId){
    return { ok:false, error:'Already claimed on board ' + m.claim.board };   // the loser of a race sees this
  }
  var used = tActiveClaims_(t);
  if(m.claim && m.claim.by === clientId) delete used[m.claim.board];   // reclaiming your own keeps the board
  var board = 0;
  for(var b = 1; b <= (t.boards || 1); b++){ if(!used[b]){ board = b; break; } }
  if(!board) return { ok:false, error:'Every board is busy right now' };
  m.claim = { by: clientId, at: now, board: board };
  writeTournament_(t);
  return { ok:true, state: readState_(), board: board };
}

function releaseMatch_(id, matchId){
  var t = loadTournament_(id);
  if(!t) return { ok:false, error:'That tournament is not on file' };
  var m = tMatch_(t, matchId);
  if(m) m.claim = null;
  writeTournament_(t);
  return { ok:true, state: readState_() };
}

// One entry point for every bracket change. 'result' is open to guests; the corrective ops
// (editResult, voidResult, reopen, reset) are gated to managers in the router.
function updateTournament_(id, op, payload, ctx){
  if(op === 'reset'){ deleteTournament_(id); return { ok:true, state: readState_() }; }
  var t = loadTournament_(id);
  if(!t) return { ok:false, error:'That tournament is not on file' };
  if(op === 'result'){
    if(!tournamentAuthed_(t, ctx)) return { ok:false, error:JOIN_REFUSAL };
    return tResult_(t, payload);
  }
  if(op === 'editResult') return tEdit_(t, payload);
  if(op === 'voidResult') return tVoid_(t, payload);
  if(op === 'reopen')     return tReopen_(t, payload);
  if(op === 'markPaid')   return tMarkPaid_(t, payload, ctx);
  if(op === 'regenCode')  return tRegenCode_(t);
  if(op === 'splitThird'){
    if(!tournamentAuthed_(t, ctx)) return { ok:false, error:JOIN_REFUSAL };
    return tSplitThird_(t);
  }
  if(op === 'setThird')   return tSetThird_(t, payload);
  return { ok:false, error:'Unknown tournament op: ' + op };
}

// Split third place: cancel the match, record both losers as tied for third. Open to either
// entrant (no manager) — it is their money — but only before anyone has claimed or played it.
function tSplitThird_(t){
  var tp = t.thirdPlace;
  if(!tp || tp.split) return { ok:false, error:'There is no third-place match to split' };
  if(tp.played) return { ok:false, error:'That match has already been played' };
  if(tp.claim && (Date.now() - tp.claim.at) < CLAIM_TTL_MS) return { ok:false, error:'That match is already under way' };
  t.thirdPlace = { thirdPlace: true, split: true, tied: [tp.a, tp.b] };
  return tFinish_(t);
}

// Manager toggle for the third-place setting. Turning it off skips the match (tied for third,
// split payout); turning it back on regenerates a fresh playoff from the current semifinals.
function tSetThird_(t, payload){
  var on = !!(payload && payload.enabled);
  t.thirdEnabled = on;
  if(on && t.thirdPlace && t.thirdPlace.split) t.thirdPlace = null;   // add it back → recompute makes a pending match
  return tFinish_(t);   // tThirdPlace_ turns a pending match into a split when off, or back into a match when on
}

// record that an entrant has (or hasn't) paid their buy-in. Manager-gated in the router.
function tMarkPaid_(t, payload, ctx){
  if(!payload || !payload.entrant) return { ok:false, error:'No entrant supplied' };
  t.ledger = t.ledger || {};
  if(payload.paid){
    t.ledger[payload.entrant] = { paid: true, by: roleOf_((ctx || {}).token), at: Date.now() };
  } else {
    delete t.ledger[payload.entrant];
  }
  writeTournament_(t);
  return { ok:true, state: readState_() };
}

// mint a fresh join code (a manager does this if the old one leaks). Manager-gated in the router.
function tRegenCode_(t){
  t.code = uniqueJoinCode_(takenCodes_(t.id));
  writeTournament_(t);
  return { ok:true, state: readState_(), code: t.code };
}

function tFinish_(t){   // persist the tournament and its archive entry together
  tThirdPlace_(t);       // keep the third-place playoff in step with the semifinals
  recomputeChampion_(t);
  writeTournament_(t);
  syncTournamentArchive_(t);
  return { ok:true, state: readState_() };
}

// report a played result and advance the winner
function tResult_(t, payload){
  var m = tMatch_(t, payload && payload.matchId);
  if(!m) return { ok:false, error:'That match is not in the bracket' };
  if(m.played) return { ok:true, state: readState_(), duplicate:true };   // idempotent — another phone reported first
  m.sh = num_(payload.sh); m.sa = num_(payload.sa);
  m.winner = payload.winner || (m.sh > m.sa ? m.a : m.b);
  m.played = true; m.claim = null;
  tFeedForward_(t);
  return tFinish_(t);
}

// change an already-played result. If it flips the winner and a later round has been played,
// refuse — the manager must reopen that round first. Also replaces the Log row.
function tEdit_(t, payload){
  var m = tMatch_(t, payload && payload.matchId);
  if(!m) return { ok:false, error:'That match is not in the bracket' };
  if(m.bye) return { ok:false, error:'A bye cannot be edited' };
  var sh = num_(payload.sh), sa = num_(payload.sa);
  var newWinner = sh > sa ? m.a : (sa > sh ? m.b : null);
  if(!newWinner) return { ok:false, error:'A cup match needs a winner' };
  if(newWinner !== m.winner){
    var d = tDownstream_(t, m);
    if(d && d.played) return { ok:false, error:'A later round has already been played. Reopen it before changing this winner.' };
    if(tIsSemi_(t, m) && tThirdResolved_(t)) return { ok:false, error:'The third-place match is already settled. Reopen it before changing this winner.' };
  }
  m.sh = sh; m.sa = sa; m.winner = newWinner; m.played = true;
  tFeedForward_(t);
  if(payload.match) putRow_(getLogSheet_(), payload.match.id, matchToRow_(payload.match));   // keep the Log in step
  return tFinish_(t);
}

// discard a played result: roll the match back to the ready queue and move its Log row to
// Discarded. Refuse if the next round has already been played.
function tVoid_(t, payload){
  var m = tMatch_(t, payload && payload.matchId);
  if(!m) return { ok:false, error:'That match is not in the bracket' };
  if(m.bye) return { ok:false, error:'A bye cannot be discarded' };
  if(!m.played) return { ok:false, error:'That match has not been played' };
  var d = tDownstream_(t, m);
  if(d && d.played) return { ok:false, error:'A later round has already been played. Reopen it before discarding this result.' };
  if(tIsSemi_(t, m) && tThirdResolved_(t)) return { ok:false, error:'The third-place match is already settled. Reopen it before discarding this result.' };
  m.sh = null; m.sa = null; m.winner = null; m.played = false; m.claim = null;
  tFeedForward_(t);   // clears the slot this match fed
  if(payload.match){ removeRow_(getLogSheet_(), payload.match.id); putRow_(getDiscardSheet_(), payload.match.id, matchToRow_(payload.match)); }
  return tFinish_(t);
}

// manager escape hatch: reopen a match AND every match downstream of it, discarding those
// Log rows, so a wrong early result can be corrected after later rounds were already played.
function tReopen_(t, payload){
  var m = tMatch_(t, payload && payload.matchId);
  if(!m) return { ok:false, error:'That match is not in the bracket' };
  var chain = [], cur = m;
  while(cur){ chain.push(cur); if(cur.round >= t.rounds.length - 1) break; cur = tDownstream_(t, cur); }
  chain.forEach(function(x){
    if(x.played && !x.bye && x.a && x.b) tMoveLogToDiscard_(t.name, x.a, x.b);
    if(!x.bye){ x.played = false; x.winner = null; x.sh = null; x.sa = null; x.claim = null; }
  });
  tFeedForward_(t);
  return tFinish_(t);
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
