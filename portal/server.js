'use strict';
// Cop On Top client portal: logins, camera permissions, live video (via go2rtc) and PTZ.
// Uses only Node's built-in modules, so there is nothing to npm install.

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.COT_PORT || 3000);
const DATA_DIR = process.env.COT_DATA || '/var/lib/cop-on-top';
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SETUP_FILE = path.join(DATA_DIR, 'setup-code.txt');
const PUB = path.join(__dirname, 'public');
const G2R = { host: '127.0.0.1', port: 1984 };
const SESSION_MS = 12 * 3600 * 1000;

// ---------------------------------------------------------------- storage
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: [], cameras: [], setupCode: null }; }
}
let db = loadDb();
function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}
const newId = (p) => p + crypto.randomBytes(5).toString('hex');

// First run: create a one-time setup code that only someone with server access can read.
if (db.users.length === 0) {
  if (!db.setupCode) db.setupCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  saveDb();
  try { fs.writeFileSync(SETUP_FILE, db.setupCode + '\n', { mode: 0o600 }); } catch (e) { console.error(e); }
  console.log('Setup code:', db.setupCode);
}

// ---------------------------------------------------------------- passwords + sessions
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') };
}
function checkPw(user, pw) {
  const h = Buffer.from(hashPw(pw, user.salt).hash, 'hex');
  const s = Buffer.from(user.hash, 'hex');
  return h.length === s.length && crypto.timingSafeEqual(h, s);
}
const sessions = new Map(); // token -> { uid, exp }
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
function currentUser(req) {
  const tok = getCookie(req, 'cot_s');
  if (!tok) return null;
  const s = sessions.get(tok);
  if (!s || s.exp < Date.now()) { sessions.delete(tok); return null; }
  return db.users.find(u => u.id === s.uid) || null;
}
const fails = new Map(); // ip -> { n, until }
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ---------------------------------------------------------------- helpers
function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 65536) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const publicUser = u => ({ id: u.id, name: u.name, username: u.username, role: u.role, cameras: u.cameras || [] });
const publicCam = c => ({ id: c.id, name: c.name, site: c.site, ptz: !!c.ptz, hd: !!c.hdChannel });
const adminCam = c => ({ id: c.id, name: c.name, site: c.site, host: c.host, webPort: c.webPort, rtspPort: c.rtspPort, channel: c.channel, hdChannel: c.hdChannel || null, ptz: !!c.ptz, camUser: c.camUser, hasPass: !!c.camPass });
function camsFor(u) {
  return u.role === 'admin' ? db.cameras : db.cameras.filter(c => (u.cameras || []).includes(c.id));
}
const clean = (v, max = 80) => String(v == null ? '' : v).trim().slice(0, max);
const port = v => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : null; };

// ---------------------------------------------------------------- go2rtc streams
function g2r(method, p) {
  return new Promise((resolve) => {
    const r = http.request({ host: G2R.host, port: G2R.port, method, path: p, timeout: 5000 }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve({ status: 0, body: '' }));
    r.end();
  });
}
function rtspUrl(c, ch) {
  const auth = c.camUser ? encodeURIComponent(c.camUser) + ':' + encodeURIComponent(c.camPass || '') + '@' : '';
  return `rtsp://${auth}${c.host}:${c.rtspPort}/Streaming/Channels/${ch}`;
}
// Each camera gets a standard stream (id) and, if set, an HD stream (id_hd).
// go2rtc only pulls from the camera while someone is watching that stream.
function streamDefs(c) {
  const d = { [c.id]: rtspUrl(c, c.channel || 102) };
  if (c.hdChannel) d[c.id + '_hd'] = rtspUrl(c, c.hdChannel);
  return d;
}
async function pushStream(c) {
  await g2r('DELETE', '/api/streams?src=' + encodeURIComponent(c.id));
  await g2r('DELETE', '/api/streams?src=' + encodeURIComponent(c.id + '_hd'));
  for (const [name, src] of Object.entries(streamDefs(c))) {
    await g2r('PUT', '/api/streams?name=' + encodeURIComponent(name) + '&src=' + encodeURIComponent(src));
  }
}
async function syncStreams(force) {
  const r = await g2r('GET', '/api/streams');
  if (r.status !== 200) return false;
  let have = {}; try { have = JSON.parse(r.body) || {}; } catch {}
  const want = new Set();
  for (const c of db.cameras) {
    const names = Object.keys(streamDefs(c)); names.forEach(n => want.add(n));
    if (force || names.some(n => !have[n])) await pushStream(c);
  }
  for (const name of Object.keys(have)) if (!want.has(name)) await g2r('DELETE', '/api/streams?src=' + encodeURIComponent(name));
  return true;
}
(async function initialSync() {
  for (let i = 0; i < 30; i++) { if (await syncStreams(true)) return; await new Promise(r => setTimeout(r, 2000)); }
  console.error('go2rtc not reachable');
})();
setInterval(() => syncStreams(false), 5 * 60 * 1000);

// ---------------------------------------------------------------- camera HTTP (ISAPI) with Digest auth
function digestHeader(h, method, uri, user, pass) {
  const p = {};
  h.replace(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g, (m, k, q, v) => { p[k.toLowerCase()] = q !== undefined ? q : v; });
  const md5 = s => crypto.createHash('md5').update(s).digest('hex');
  const ha1 = md5(`${user}:${p.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = p.qop ? p.qop.split(',')[0].trim() : '';
  const nc = '00000001', cnonce = crypto.randomBytes(8).toString('hex');
  const response = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  let out = `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", response="${response}"`;
  if (p.opaque) out += `, opaque="${p.opaque}"`;
  if (p.algorithm) out += `, algorithm=${p.algorithm}`;
  if (qop) out += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  return out;
}
function isapi(c, method, uri, body) {
  return new Promise((resolve) => {
    const go = (auth) => {
      const headers = {};
      if (body) { headers['Content-Type'] = 'application/xml'; headers['Content-Length'] = Buffer.byteLength(body); }
      if (auth) headers.Authorization = auth;
      const r = http.request({ host: c.host, port: c.webPort, method, path: uri, headers, timeout: 6000 }, res => {
        let d = ''; res.on('data', x => d += x);
        res.on('end', () => {
          const wa = res.headers['www-authenticate'];
          if (res.statusCode === 401 && !auth && wa) {
            const list = Array.isArray(wa) ? wa : [wa];
            const dig = list.find(x => /^digest/i.test(x));
            if (dig) return go(digestHeader(dig, method, uri, c.camUser || '', c.camPass || ''));
            if (list.find(x => /^basic/i.test(x))) return go('Basic ' + Buffer.from(`${c.camUser}:${c.camPass}`).toString('base64'));
          }
          resolve({ status: res.statusCode, body: d });
        });
      });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', e => resolve({ status: 0, body: e.message }));
      if (body) r.write(body);
      r.end();
    };
    go(null);
  });
}
const ptzTimers = new Map();
function ptzMove(c, pan, tilt, zoom) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><PTZData><pan>${pan}</pan><tilt>${tilt}</tilt><zoom>${zoom}</zoom></PTZData>`;
  return isapi(c, 'PUT', '/ISAPI/PTZCtrl/channels/1/continuous', xml);
}
function armWatchdog(c) {
  clearTimeout(ptzTimers.get(c.id));
  ptzTimers.set(c.id, setTimeout(() => { ptzMove(c, 0, 0, 0); ptzTimers.delete(c.id); }, 1600));
}
function tcpCheck(host, p) {
  return new Promise(resolve => {
    const s = net.connect({ host, port: p });
    const done = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(5000, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

// ---------------------------------------------------------------- API
async function api(req, res, u, url) {
  const p = url.pathname;
  const m = req.method;
  if (m !== 'GET' && req.headers['x-cot'] !== '1') return send(res, 403, { error: 'Bad request' });

  if (p === '/api/state' && m === 'GET') return send(res, 200, { needsSetup: db.users.length === 0 });

  if (p === '/api/setup' && m === 'POST') {
    if (db.users.length) return send(res, 400, { error: 'The portal is already set up.' });
    const b = await readJson(req);
    if (!db.setupCode || clean(b.code, 20).toUpperCase() !== db.setupCode) return send(res, 400, { error: 'That setup code is wrong. Check it in the server console.' });
    const username = clean(b.username, 40).toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) return send(res, 400, { error: 'Usernames use 3 to 40 letters, numbers, dots, dashes or underscores.' });
    if (String(b.password || '').length < 10) return send(res, 400, { error: 'Use a password of at least 10 characters.' });
    const user = Object.assign({ id: newId('u_'), name: clean(b.name) || username, username, role: 'admin', cameras: [] }, hashPw(b.password));
    db.users.push(user); db.setupCode = null; saveDb();
    try { fs.unlinkSync(SETUP_FILE); } catch {}
    return send(res, 200, { ok: true });
  }

  if (p === '/api/login' && m === 'POST') {
    const ip = clientIp(req);
    const f = fails.get(ip);
    if (f && f.n >= 8 && f.until > Date.now()) return send(res, 429, { error: 'Too many tries. Wait 15 minutes and try again.' });
    const b = await readJson(req);
    const user = db.users.find(x => x.username === clean(b.username, 40).toLowerCase());
    if (!user || !checkPw(user, String(b.password || ''))) {
      const n = (f && f.until > Date.now() ? f.n : 0) + 1;
      fails.set(ip, { n, until: Date.now() + 15 * 60 * 1000 });
      return send(res, 401, { error: "That username and password don't match." });
    }
    fails.delete(ip);
    const tok = crypto.randomBytes(32).toString('hex');
    sessions.set(tok, { uid: user.id, exp: Date.now() + SESSION_MS });
    return send(res, 200, { ok: true, role: user.role }, { 'Set-Cookie': `cot_s=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MS / 1000}` });
  }

  if (p === '/api/logout' && m === 'POST') {
    const tok = getCookie(req, 'cot_s'); if (tok) sessions.delete(tok);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'cot_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  }

  if (!u) return send(res, 401, { error: 'Please log in.' });

  if (p === '/api/me' && m === 'GET') return send(res, 200, publicUser(u));
  if (p === '/api/cameras' && m === 'GET') return send(res, 200, camsFor(u).map(publicCam));

  if (p === '/api/password' && m === 'POST') {
    const b = await readJson(req);
    if (!checkPw(u, String(b.current || ''))) return send(res, 400, { error: 'Your current password is wrong.' });
    if (String(b.next || '').length < 10) return send(res, 400, { error: 'Use a new password of at least 10 characters.' });
    Object.assign(u, hashPw(b.next)); saveDb();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/ptz' && m === 'POST') {
    const b = await readJson(req);
    const c = camsFor(u).find(x => x.id === b.cam);
    if (!c) return send(res, 404, { error: 'Camera not found.' });
    if (!c.ptz) return send(res, 400, { error: 'This camera has no PTZ.' });
    const lim = v => Math.max(-100, Math.min(100, Math.round(Number(v) || 0)));
    let r;
    if (b.action === 'move') { r = await ptzMove(c, lim(b.pan), lim(b.tilt), lim(b.zoom)); armWatchdog(c); }
    else if (b.action === 'stop') { clearTimeout(ptzTimers.get(c.id)); r = await ptzMove(c, 0, 0, 0); }
    else if (b.action === 'home') {
      r = await isapi(c, 'PUT', '/ISAPI/PTZCtrl/channels/1/homeposition/goto');
      if (r.status !== 200) r = await isapi(c, 'PUT', '/ISAPI/PTZCtrl/channels/1/presets/1/goto');
      if (r.status !== 200 && r.status !== 401 && r.status !== 0) return send(res, 400, { error: u.role === 'admin' ? 'No Home position saved yet. Point the camera, then click "Save this view as Home".' : 'No Home position is set on this camera yet.' });
    }
    else if (b.action === 'sethome') {
      if (u.role !== 'admin') return send(res, 403, { error: 'Admins only.' });
      r = await isapi(c, 'PUT', '/ISAPI/PTZCtrl/channels/1/homeposition');
      if (r.status !== 200) return send(res, 400, { error: r.status === 401 || r.status === 403 ? "The camera's webportal user isn't allowed to save Home. Set it in the camera's own PTZ settings instead." : 'The camera refused to save Home (code ' + r.status + ').' });
    }
    else return send(res, 400, { error: 'Unknown action.' });
    if (r.status === 200) return send(res, 200, { ok: true });
    return send(res, 502, { error: r.status === 401 ? 'The camera rejected the portal login.' : r.status === 0 ? "Can't reach the camera." : 'The camera refused that command.' });
  }

  // ------------- admin only
  if (!p.startsWith('/api/admin/')) return send(res, 404, { error: 'Not found' });
  if (u.role !== 'admin') return send(res, 403, { error: 'Admins only.' });

  if (p === '/api/admin/data' && m === 'GET') {
    return send(res, 200, { cameras: db.cameras.map(adminCam), users: db.users.map(publicUser), me: u.id });
  }

  if (p === '/api/admin/cameras' && m === 'POST') {
    const b = await readJson(req);
    const existing = b.id ? db.cameras.find(c => c.id === b.id) : null;
    if (b.id && !existing) return send(res, 404, { error: 'Camera not found.' });
    const host = clean(b.host, 100);
    if (!/^[a-zA-Z0-9.-]+$/.test(host)) return send(res, 400, { error: 'Enter the IP address only, like 75.122.251.0 (no http:// or port).' });
    const webPort = port(b.webPort), rtspPort = port(b.rtspPort);
    if (!webPort || !rtspPort) return send(res, 400, { error: 'Enter both port numbers.' });
    const cam = existing || { id: newId('c_') };
    Object.assign(cam, {
      name: clean(b.name) || 'Camera', site: clean(b.site) || 'Site', host, webPort, rtspPort,
      channel: port(b.channel) || 102, hdChannel: port(b.hdChannel), ptz: !!b.ptz, camUser: clean(b.camUser, 40),
    });
    if (b.camPass) cam.camPass = String(b.camPass).slice(0, 100);
    if (!existing) db.cameras.push(cam);
    saveDb();
    await pushStream(cam);
    return send(res, 200, { ok: true, id: cam.id });
  }
  if (p === '/api/admin/cameras' && m === 'DELETE') {
    const id = url.searchParams.get('id');
    db.cameras = db.cameras.filter(c => c.id !== id);
    db.users.forEach(x => { x.cameras = (x.cameras || []).filter(cid => cid !== id); });
    saveDb(); await g2r('DELETE', '/api/streams?src=' + encodeURIComponent(id)); await g2r('DELETE', '/api/streams?src=' + encodeURIComponent(id + '_hd'));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/test' && m === 'POST') {
    const b = await readJson(req);
    const c = db.cameras.find(x => x.id === b.id);
    if (!c) return send(res, 404, { error: 'Camera not found.' });
    const [web, video] = await Promise.all([tcpCheck(c.host, c.webPort), tcpCheck(c.host, c.rtspPort)]);
    let login = 'skipped';
    if (web) {
      const r = await isapi(c, 'GET', '/ISAPI/System/deviceInfo');
      login = r.status === 200 ? 'ok' : r.status === 401 ? 'rejected' : 'error ' + r.status;
    }
    return send(res, 200, { web, video, login });
  }

  if (p === '/api/admin/users' && m === 'POST') {
    const b = await readJson(req);
    const existing = b.id ? db.users.find(x => x.id === b.id) : null;
    if (b.id && !existing) return send(res, 404, { error: 'User not found.' });
    const username = clean(b.username, 40).toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) return send(res, 400, { error: 'Usernames use 3 to 40 letters, numbers, dots, dashes or underscores.' });
    if (db.users.find(x => x.username === username && x !== existing)) return send(res, 400, { error: 'That username is taken.' });
    if (!existing && String(b.password || '').length < 10) return send(res, 400, { error: 'Use a password of at least 10 characters.' });
    if (b.password && String(b.password).length < 10) return send(res, 400, { error: 'Use a password of at least 10 characters.' });
    const role = b.role === 'admin' ? 'admin' : 'client';
    if (existing && existing.id === u.id && role !== 'admin') return send(res, 400, { error: "You can't remove your own admin access." });
    const user = existing || { id: newId('u_') };
    Object.assign(user, {
      name: clean(b.name) || username, username, role,
      cameras: Array.isArray(b.cameras) ? b.cameras.filter(id => db.cameras.find(c => c.id === id)) : [],
    });
    if (b.password) Object.assign(user, hashPw(b.password));
    if (!existing) db.users.push(user);
    if (b.password && existing) for (const [tok, s] of sessions) if (s.uid === user.id && user.id !== u.id) sessions.delete(tok);
    saveDb();
    return send(res, 200, { ok: true, id: user.id });
  }
  if (p === '/api/admin/users' && m === 'DELETE') {
    const id = url.searchParams.get('id');
    if (id === u.id) return send(res, 400, { error: "You can't delete your own account." });
    db.users = db.users.filter(x => x.id !== id);
    for (const [tok, s] of sessions) if (s.uid === id) sessions.delete(tok);
    saveDb();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------- pages
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const SEC = { 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
function serveFile(res, file, extra = {}) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, SEC, extra));
    res.end(data);
  });
}
function redirect(res, to) { res.writeHead(302, { Location: to }); res.end(); }
function proxyVendor(res, name) {
  const r = http.request({ host: G2R.host, port: G2R.port, path: '/' + name, method: 'GET' }, up => {
    res.writeHead(up.statusCode, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=3600' });
    up.pipe(res);
  });
  r.on('error', () => { res.writeHead(502); res.end(); });
  r.end();
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const u = currentUser(req);

  if (p.startsWith('/api/')) return api(req, res, u, url);
  if (p === '/portal') return redirect(res, '/portal/');
  if (p === '/portal/vendor/video-stream.js' || p === '/portal/vendor/video-rtc.js') return proxyVendor(res, path.basename(p));
  if (p === '/portal/portal.css') return serveFile(res, path.join(PUB, 'portal.css'));
  if (p === '/portal/setup') return db.users.length ? redirect(res, '/portal/login') : serveFile(res, path.join(PUB, 'setup.html'));
  if (p === '/portal/login') {
    if (!db.users.length) return redirect(res, '/portal/setup');
    return u ? redirect(res, '/portal/') : serveFile(res, path.join(PUB, 'login.html'));
  }
  if (p === '/portal/') {
    if (!db.users.length) return redirect(res, '/portal/setup');
    return u ? serveFile(res, path.join(PUB, 'index.html')) : redirect(res, '/portal/login');
  }
  if (p === '/portal/admin') {
    if (!u) return redirect(res, '/portal/login');
    return u.role === 'admin' ? serveFile(res, path.join(PUB, 'admin.html')) : redirect(res, '/portal/');
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, { error: 'Something went wrong on the server.' }); else res.end(); });
});

// Live video: the browser opens a WebSocket to /api/ws?cam=ID. We check the login and the
// camera permission here, then hand the connection to go2rtc on localhost.
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://local');
  const u = currentUser(req);
  const cam = u && url.pathname === '/api/ws' ? camsFor(u).find(c => c.id === url.searchParams.get('cam')) : null;
  if (!cam) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const src = url.searchParams.get('q') === 'hd' && cam.hdChannel ? cam.id + '_hd' : cam.id;
  const up = net.connect(G2R.port, G2R.host, () => {
    const skip = new Set(['cookie', 'origin', 'host']);
    let raw = `GET /api/ws?src=${encodeURIComponent(src)} HTTP/1.1\r\nHost: ${G2R.host}:${G2R.port}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!skip.has(req.rawHeaders[i].toLowerCase())) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    up.write(raw + '\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  const close = () => { up.destroy(); socket.destroy(); };
  up.on('error', close); socket.on('error', close);
  up.on('close', close); socket.on('close', close);
});

setInterval(() => { const now = Date.now(); for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t); }, 3600 * 1000);

server.listen(PORT, '127.0.0.1', () => console.log('Cop On Top portal on 127.0.0.1:' + PORT));
