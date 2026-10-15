"use strict";
/*
 * Envio CMS for Vercel (serverless). Same behaviour and API as server.js, but:
 *   - state lives in a storage adapter (Vercel Blob in production) instead of local files,
 *   - login sessions are stateless signed cookies (any function instance can verify them),
 *   - public pages and /assets/content.js are rendered per request from the stored content,
 *     so a publish is live immediately (no build step, no file writes).
 * server.js (local/Node hosting) is untouched and keeps working as before.
 *
 * Storage adapter contract (all async):
 *   getText(key) -> string|null       putText(key, text, contentType)
 *   getBuffer(key) -> {buffer, contentType}|null      putBuffer(key, buffer, contentType)
 *   list(prefix) -> [{ key, size, uploadedAt }]       del(keys[])
 * Keys: content.json, meta.json, users.json, backups/content-<iso>.json, uploads/up-<hex>.<ext>
 */
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var auth = require("../cms-auth");
var builder = require("../build-content");
var R = require("../assets/render.js");

var ROOT = path.join(__dirname, "..");
var SESSION_TTL = 8 * 60 * 60 * 1000;
var COOKIE = "cms_session";
var KEEP_BACKUPS = 5;
var CAP_LOGIN = 4 * 1024;
var CAP_CONTENT = 4 * 1024 * 1024; // Vercel request bodies are capped at ~4.5 MB
var CAP_IMAGE = 4 * 1024 * 1024;
var MAX_IMAGE = 2 * 1024 * 1024;
var BACKUP_RE = /^content-[0-9A-Za-z\-]+\.json$/;
var UPLOAD_RE = /^up-[0-9a-f]+\.(png|jpe?g|webp)$/i;
var PAGE_FOR = { "/": "home", "/index.html": "home", "/about.html": "about", "/products.html": "products", "/contact.html": "contact" };
var MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

function createHandler(store, opts){
  opts = opts || {};
  var SECRET = opts.secret != null ? opts.secret : (process.env.CMS_SESSION_SECRET || "");
  var BOOT_USER = opts.bootUser != null ? opts.bootUser : process.env.CMS_BOOTSTRAP_USER;
  var BOOT_PASS = opts.bootPass != null ? opts.bootPass : process.env.CMS_BOOTSTRAP_PASSWORD;
  var SEED = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "content.seed.json"), "utf8"));
  var ADMIN_HTML = null;

  /* ---------------- tiny helpers ---------------- */
  function send(res, status, body, type, headers){ var h = { "Content-Type": type || "text/plain; charset=utf-8" }; if(headers) for(var k in headers) h[k] = headers[k]; res.writeHead(status, h); res.end(body); }
  function json(res, status, obj, headers){ send(res, status, JSON.stringify(obj), "application/json; charset=utf-8", Object.assign({ "Cache-Control": "no-store" }, headers || {})); }
  function b64u(buf){ return Buffer.from(buf).toString("base64url"); }
  function readBody(req, limit){
    return new Promise(function(resolve, reject){
      var len = parseInt(req.headers["content-length"] || "0", 10);
      if(len && len > limit) return reject({ status: 413, msg: "Payload terlalu besar (maks " + Math.round(limit / 1024) + " KB)." });
      if(req.body !== undefined && req.body !== null){ // Vercel pre-parses JSON bodies
        var b = req.body, raw = typeof b === "string" ? b : (Buffer.isBuffer(b) ? b.toString("utf8") : JSON.stringify(b));
        if(Buffer.byteLength(raw) > limit) return reject({ status: 413, msg: "Payload terlalu besar." });
        return resolve(raw);
      }
      var chunks = [], size = 0;
      req.on("data", function(c){ size += c.length; if(size > limit){ reject({ status: 413, msg: "Payload terlalu besar." }); try { req.destroy(); } catch(e){} return; } chunks.push(c); });
      req.on("end", function(){ resolve(Buffer.concat(chunks).toString("utf8")); });
      req.on("error", function(){ reject({ status: 400, msg: "Gagal membaca permintaan." }); });
    });
  }
  function parseJson(raw){ try { return JSON.parse(raw || "{}"); } catch(e){ return {}; } }

  /* ---------------- stored state (small TTL memo, invalidated on our own writes) ---------------- */
  var memo = {};
  function memoGet(k, ttl){ var m = memo[k]; return m && (Date.now() - m.t) < ttl ? m.v : undefined; }
  function memoSet(k, v){ memo[k] = { t: Date.now(), v: v }; return v; }
  function memoDrop(k){ delete memo[k]; }

  function loadMeta(){
    var c = memoGet("meta", 3000); if(c) return Promise.resolve(c);
    return store.getText("meta.json").then(function(t){ var m = {}; try { m = t ? JSON.parse(t) : {}; } catch(e){} m.version = m.version || 1; m.backups = m.backups || {}; m.lastPublish = m.lastPublish || null; return memoSet("meta", m); });
  }
  function saveMeta(m){ return store.putText("meta.json", JSON.stringify(m), "application/json").then(function(){ memoSet("meta", m); }); }
  function loadContentText(){
    return store.getText("content.json").then(function(t){ return t || JSON.stringify(SEED, null, 2) + "\n"; });
  }
  function loadContent(){
    var c = memoGet("content", 3000); if(c) return Promise.resolve(c);
    return loadContentText().then(function(t){ var d; try { d = JSON.parse(t); } catch(e){ d = SEED; } return memoSet("content", d); });
  }
  function loadUsers(){
    var c = memoGet("users", 3000); if(c) return Promise.resolve(c);
    return store.getText("users.json").then(function(t){
      var db = { users: {} }; try { if(t) db = JSON.parse(t); } catch(e){}
      if(!db.users) db.users = {};
      if(!Object.keys(db.users).length && BOOT_USER && BOOT_PASS && String(BOOT_PASS).length >= 8){
        var h = auth.hashPassword(BOOT_PASS), now = new Date().toISOString();
        db.users[BOOT_USER] = { salt: h.salt, hash: h.hash, createdAt: now, updatedAt: now };
        return saveUsers(db).then(function(){ return db; });
      }
      return memoSet("users", db);
    });
  }
  function saveUsers(db){ memoDrop("users"); return store.putText("users.json", JSON.stringify(db, null, 2), "application/json").then(function(){ memoSet("users", db); }); }

  /* ---------------- sessions: stateless signed cookie ---------------- */
  function sign(payloadB64){ return crypto.createHmac("sha256", SECRET).update(payloadB64).digest("base64url"); }
  function makeToken(username, user, csrf){ var p = b64u(JSON.stringify({ u: username, c: csrf || crypto.randomBytes(24).toString("hex"), e: Date.now() + SESSION_TTL, s: (user && user.updatedAt) || "" })); return p + "." + sign(p); }
  function parseCookies(req){ var out = {}, h = req.headers.cookie; if(h) h.split(";").forEach(function(p){ var i = p.indexOf("="); if(i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }); return out; }
  function isSecureReq(req){ var xfp = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase(); if(xfp) return xfp === "https"; return process.env.CMS_SECURE_COOKIE !== "0" && !opts.insecureCookies; }
  function cookieHeader(value, maxAge, secure){ return COOKIE + "=" + value + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + maxAge + (secure ? "; Secure" : ""); }
  function currentUser(req){
    if(!SECRET) return Promise.resolve(null);
    var value = parseCookies(req)[COOKIE]; if(!value) return Promise.resolve(null);
    var i = value.lastIndexOf("."); if(i < 0) return Promise.resolve(null);
    var p = value.slice(0, i), sig = value.slice(i + 1), expect = sign(p);
    var a = Buffer.from(sig), b = Buffer.from(expect);
    if(a.length !== b.length || !crypto.timingSafeEqual(a, b)) return Promise.resolve(null);
    var d; try { d = JSON.parse(Buffer.from(p, "base64url").toString("utf8")); } catch(e){ return Promise.resolve(null); }
    if(!d || !d.u || d.e < Date.now()) return Promise.resolve(null);
    return loadUsers().then(function(db){
      var u = auth.getUser(db, d.u); if(!u || (u.updatedAt || "") !== (d.s || "")) return null;
      return { username: d.u, csrf: d.c, credStamp: d.s, refresh: (d.e - Date.now()) < (SESSION_TTL - 5 * 60 * 1000) };
    });
  }
  function csrfOk(req, sess){ var hdr = req.headers["x-csrf-token"] || ""; var a = Buffer.from(String(hdr)), b = Buffer.from(sess.csrf); return a.length === b.length && crypto.timingSafeEqual(a, b); }
  // sliding session: re-issue the cookie on activity once 5 min of the window have passed
  function authedJson(req, res, sess, status, obj){ var h = {}; if(sess && sess.refresh){ h["Set-Cookie"] = cookieHeader(makeToken(sess.username, { updatedAt: sess.credStamp }, sess.csrf), SESSION_TTL / 1000, isSecureReq(req)); } json(res, status, obj, h); }

  /* ---------------- login throttling (best-effort, per instance) ---------------- */
  var ipFails = {}, userFails = {};
  function blockSecs(map, key){ var r = map[key]; if(r && r.lockUntil && Date.now() < r.lockUntil) return Math.ceil((r.lockUntil - Date.now()) / 1000); return 0; }
  function bump(map, key){ var r = map[key] || { count: 0, lockUntil: 0 }; r.count++; if(r.count >= 5){ var over = r.count - 4; r.lockUntil = Date.now() + Math.min(30000 * Math.pow(2, over - 1), 15 * 60 * 1000); } map[key] = r; }
  function clientIp(req){ var xff = req.headers["x-forwarded-for"]; if(xff) return String(xff).split(",")[0].trim(); return (req.socket && req.socket.remoteAddress) || "?"; }

  /* ---------------- content ---------------- */
  function validateContent(obj){
    var errs = [];
    if(!obj || typeof obj !== "object" || Array.isArray(obj)) return ["Payload bukan objek JSON."];
    ["settings", "collections", "pages"].forEach(function(k){ if(!obj[k] || typeof obj[k] !== "object") errs.push("Bagian '" + k + "' hilang atau bukan objek."); });
    if(obj.settings){ ["identity", "contact", "nav", "footer"].forEach(function(k){ if(!obj.settings[k]) errs.push("settings." + k + " hilang."); }); }
    if(obj.pages){ ["home", "about", "products", "contact"].forEach(function(k){ if(!obj.pages[k]) errs.push("pages." + k + " hilang."); }); }
    return errs;
  }
  function publish(parsed, username, note){
    // refuse to store content that cannot be rendered (the local build step's rollback, done up front)
    try { Object.keys(R.PAGE_FILES).forEach(function(pg){ builder.renderPageHtml(parsed, pg); }); }
    catch(e){ return Promise.reject(new Error("Konten tidak bisa ditampilkan, tidak disimpan: " + e.message)); }
    var stamp = new Date().toISOString().replace(/[:.]/g, "-"), name = "content-" + stamp + ".json";
    return Promise.all([loadContentText(), loadMeta()]).then(function(r){
      var curText = r[0], meta = JSON.parse(JSON.stringify(r[1]));
      return store.putText("backups/" + name, curText, "application/json").then(function(){
        return store.putText("content.json", JSON.stringify(parsed, null, 2) + "\n", "application/json");
      }).then(function(){
        meta.version = (meta.version || 1) + 1;
        meta.backups[name] = { user: username, time: new Date().toISOString() };
        var names = Object.keys(meta.backups).sort(), drop = [];
        while(names.length > KEEP_BACKUPS){ var old = names.shift(); delete meta.backups[old]; drop.push("backups/" + old); }
        meta.lastPublish = { time: new Date().toISOString(), user: username, summary: note + ", v" + meta.version + " (backup " + name + ")" };
        memoDrop("content");
        return saveMeta(meta).then(function(){ return drop.length ? store.del(drop).catch(function(){}) : null; }).then(function(){ return { version: meta.version, backup: name }; });
      });
    });
  }

  /* ---------------- images ---------------- */
  function detectImage(buf){ if(buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "png"; if(buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "jpg"; if(buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp"; return null; }
  function staticImages(){
    try { var m = JSON.parse(fs.readFileSync(path.join(ROOT, "images-manifest.json"), "utf8")); if(Array.isArray(m)) return m; } catch(e){}
    var base = path.join(ROOT, "assets", "images"), out = [];
    (function walk(dir){ var ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch(e){ return; } ents.forEach(function(en){ var fp = path.join(dir, en.name); if(en.isDirectory()) walk(fp); else if(/\.(png|jpe?g|webp)$/i.test(en.name)) out.push("assets/images/" + path.relative(base, fp).split(path.sep).join("/")); }); })(base);
    return out;
  }
  function listImages(){
    return store.list("uploads/").then(function(items){
      var ups = items.map(function(i){ return "assets/images/uploads/" + i.key.replace(/^uploads\//, ""); }).filter(function(p){ return UPLOAD_RE.test(p.split("/").pop()); });
      return ups.concat(staticImages().filter(function(p){ return p.indexOf("assets/images/uploads/") !== 0; }).sort()).slice(0, 300);
    }).catch(function(){ return staticImages().sort().slice(0, 300); });
  }

  /* ---------------- the request handler ---------------- */
  function backupList(){
    return Promise.all([loadMeta(), store.list("backups/")]).then(function(r){
      var meta = r[0], seen = {};
      return r[1].map(function(i){ return i.key.replace(/^backups\//, ""); }).filter(function(n){ return BACKUP_RE.test(n); }).map(function(n){ var m = meta.backups[n] || {}; seen[n] = 1; return { name: n, time: m.time || "", user: m.user || "?" }; }).sort(function(a, b){ return a.name < b.name ? 1 : -1; });
    });
  }
  function needAuth(req, res, write){
    return currentUser(req).then(function(s){
      if(write && !SECRET){ json(res, 503, { error: "CMS belum dikonfigurasi." }); return null; }
      if(!s){ json(res, 401, { error: "Belum login." }); return null; }
      if(write && !csrfOk(req, s)){ json(res, 403, { error: "Token CSRF tidak valid." }); return null; }
      return s;
    });
  }
  function pageResponse(req, res, url){
    return loadContent().then(function(content){
      var html = builder.renderPageHtml(content, PAGE_FOR[url]);
      send(res, 200, req.method === "HEAD" ? "" : html, "text/html; charset=utf-8", { "Cache-Control": "public, max-age=0, s-maxage=5, stale-while-revalidate=30" });
    });
  }

  function route(req, res, url, query){
    var m = req.method;

    if(url === "/api/login" && m === "POST"){
      if(!SECRET) return json(res, 503, { error: "CMS belum dikonfigurasi (CMS_SESSION_SECRET kosong)." });
      var ip = clientIp(req), ipWait = blockSecs(ipFails, ip);
      if(ipWait) return json(res, 429, { error: "Terlalu banyak percobaan. Coba lagi dalam " + ipWait + " detik.", retryAfter: ipWait });
      return readBody(req, CAP_LOGIN).then(function(raw){
        var b = parseJson(raw), username = String(b.username || ""), wait = Math.max(blockSecs(ipFails, ip), blockSecs(userFails, "u:" + username));
        if(wait) return json(res, 429, { error: "Terlalu banyak percobaan. Coba lagi dalam " + wait + " detik.", retryAfter: wait });
        return loadUsers().then(function(db){
          var user = auth.getUser(db, username);
          return auth.verifyPasswordAsync(String(b.password || ""), user).then(function(ok){
            if(!ok){ bump(ipFails, ip); bump(userFails, "u:" + username); return json(res, 401, { error: "Username atau password salah." }); }
            delete ipFails[ip]; delete userFails["u:" + username];
            var csrf = crypto.randomBytes(24).toString("hex");
            json(res, 200, { ok: true, username: username, csrf: csrf }, { "Set-Cookie": cookieHeader(makeToken(username, user, csrf), SESSION_TTL / 1000, isSecureReq(req)) });
          });
        });
      });
    }
    if(url === "/api/logout" && m === "POST") return json(res, 200, { ok: true }, { "Set-Cookie": cookieHeader("", 0, isSecureReq(req)) });
    if(url === "/api/session") return needAuth(req, res, false).then(function(s){ if(s) authedJson(req, res, s, 200, { username: s.username, csrf: s.csrf }); });
    if(url === "/api/status") return needAuth(req, res, false).then(function(s){ if(!s) return; return loadMeta().then(function(meta){ authedJson(req, res, s, 200, { username: s.username, currentVersion: meta.version, lastPublish: meta.lastPublish }); }); });
    if(url === "/api/backups") return needAuth(req, res, false).then(function(s){ if(!s) return; return Promise.all([backupList(), loadMeta()]).then(function(r){ authedJson(req, res, s, 200, { backups: r[0], currentVersion: r[1].version }); }); });
    if(url === "/api/backup") return needAuth(req, res, false).then(function(s){ if(!s) return; var name = String(query.name || ""); if(!BACKUP_RE.test(name)) return json(res, 404, { error: "Backup tidak ditemukan." }); return store.getText("backups/" + name).then(function(t){ if(t == null) return json(res, 404, { error: "Backup tidak ditemukan." }); send(res, 200, t, "application/json; charset=utf-8", { "Cache-Control": "no-store" }); }); });
    if(url === "/api/restore" && m === "POST") return needAuth(req, res, true).then(function(s){
      if(!s) return;
      return readBody(req, CAP_LOGIN).then(function(raw){
        var b = parseJson(raw), name = String(b.name || ""); if(!BACKUP_RE.test(name)) return json(res, 404, { error: "Backup tidak ditemukan." });
        return store.getText("backups/" + name).then(function(body){
          if(body == null) return json(res, 404, { error: "Backup tidak ditemukan." });
          var parsed; try { parsed = JSON.parse(body); } catch(e){ return json(res, 400, { error: "Backup rusak." }); }
          var errs = validateContent(parsed); if(errs.length) return json(res, 400, { error: "Backup tidak valid.", details: errs });
          return publish(parsed, s.username, "RESTORE dari " + name).then(function(r){ authedJson(req, res, s, 200, { ok: true, version: r.version, backup: r.backup, restored: name }); }, function(e){ json(res, 500, { error: e.message }); });
        });
      });
    });
    if(url === "/api/image" && m === "POST") return needAuth(req, res, true).then(function(s){
      if(!s) return;
      return readBody(req, CAP_IMAGE).then(function(raw){
        var b = parseJson(raw), data = String(b.dataBase64 || "").replace(/^data:[^,]*,/, ""), buf;
        try { buf = Buffer.from(data, "base64"); } catch(e){ return json(res, 400, { error: "Data gambar tidak valid." }); }
        if(!buf.length) return json(res, 400, { error: "File kosong." });
        if(buf.length > MAX_IMAGE) return json(res, 400, { error: "Ukuran melebihi 2 MB." });
        var ext = detectImage(buf); if(!ext) return json(res, 400, { error: "Format tidak didukung. Hanya PNG, JPG, atau WEBP (SVG tidak diizinkan)." });
        var name = "up-" + crypto.randomBytes(6).toString("hex") + "." + ext;
        return store.putBuffer("uploads/" + name, buf, MIME[ext]).then(function(){ authedJson(req, res, s, 200, { ok: true, path: "assets/images/uploads/" + name }); }, function(){ json(res, 500, { error: "Gagal menyimpan file." }); });
      });
    });
    if(url === "/api/images") return needAuth(req, res, false).then(function(s){ if(!s) return; return listImages().then(function(imgs){ authedJson(req, res, s, 200, { images: imgs }); }); });
    if(url === "/api/image/delete" && m === "POST") return needAuth(req, res, true).then(function(s){
      if(!s) return;
      return readBody(req, CAP_LOGIN).then(function(raw){
        var rel = String(parseJson(raw).path || "").replace(/^\/+/, "");
        if(!/^assets\/images\/uploads\/up-[0-9a-f]+\.(png|jpe?g|webp)$/i.test(rel)) return json(res, 400, { error: "Hanya file unggahan yang bisa dihapus." });
        return store.del(["uploads/" + rel.split("/").pop()]).then(function(){ authedJson(req, res, s, 200, { ok: true }); }, function(){ json(res, 500, { error: "Gagal menghapus." }); });
      });
    });
    if(url === "/api/password" && m === "POST") return needAuth(req, res, true).then(function(s){
      if(!s) return;
      return readBody(req, CAP_LOGIN).then(function(raw){
        var b = parseJson(raw), np = String(b.new || ""); if(np.length < 8) return json(res, 400, { error: "Kata sandi baru minimal 8 karakter." });
        return loadUsers().then(function(db){
          return auth.verifyPasswordAsync(String(b.old || ""), auth.getUser(db, s.username)).then(function(ok){
            if(!ok) return json(res, 401, { error: "Kata sandi lama salah." });
            var h = auth.hashPassword(np), now = new Date().toISOString(), rec = db.users[s.username];
            db.users[s.username] = { salt: h.salt, hash: h.hash, createdAt: rec.createdAt || now, updatedAt: now };
            return saveUsers(db).then(function(){ // keep THIS browser logged in with the new credential stamp
              json(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(makeToken(s.username, db.users[s.username], s.csrf), SESSION_TTL / 1000, isSecureReq(req)) });
            });
          });
        });
      });
    });
    if(url === "/api/users"){
      if(m === "GET") return needAuth(req, res, false).then(function(s){ if(!s) return; return loadUsers().then(function(db){ authedJson(req, res, s, 200, { users: Object.keys(db.users).map(function(u){ return { username: u, createdAt: db.users[u].createdAt || "" }; }), me: s.username }); }); });
      if(m === "POST") return needAuth(req, res, true).then(function(s){
        if(!s) return;
        return readBody(req, CAP_LOGIN).then(function(raw){
          var b = parseJson(raw), un = String(b.username || "").trim(), pw = String(b.password || "");
          if(!/^[A-Za-z0-9_.-]{3,32}$/.test(un)) return json(res, 400, { error: "Nama pengguna 3-32 karakter (huruf, angka, . _ -)." });
          if(pw.length < 8) return json(res, 400, { error: "Kata sandi minimal 8 karakter." });
          return loadUsers().then(function(db){
            if(Object.prototype.hasOwnProperty.call(db.users, un)) return json(res, 400, { error: "Nama pengguna sudah dipakai." });
            return auth.verifyPasswordAsync(String(b.adminPassword || ""), auth.getUser(db, s.username)).then(function(ok){
              if(!ok) return json(res, 401, { error: "Kata sandi Anda salah." });
              var h = auth.hashPassword(pw), now = new Date().toISOString();
              db.users[un] = { salt: h.salt, hash: h.hash, createdAt: now, updatedAt: now };
              return saveUsers(db).then(function(){ authedJson(req, res, s, 200, { ok: true }); });
            });
          });
        });
      });
      return send(res, 405, "Method not allowed");
    }
    if(url === "/api/users/delete" && m === "POST") return needAuth(req, res, true).then(function(s){
      if(!s) return;
      return readBody(req, CAP_LOGIN).then(function(raw){
        var b = parseJson(raw), un = String(b.username || "");
        return loadUsers().then(function(db){
          if(!Object.prototype.hasOwnProperty.call(db.users, un)) return json(res, 404, { error: "Pengguna tidak ada." });
          if(Object.keys(db.users).length <= 1) return json(res, 400, { error: "Tidak bisa menghapus pengguna terakhir." });
          if(un === s.username) return json(res, 400, { error: "Tidak bisa menghapus akun sendiri." });
          return auth.verifyPasswordAsync(String(b.adminPassword || ""), auth.getUser(db, s.username)).then(function(ok){
            if(!ok) return json(res, 401, { error: "Kata sandi Anda salah." });
            delete db.users[un];
            return saveUsers(db).then(function(){ authedJson(req, res, s, 200, { ok: true }); });
          });
        });
      });
    });
    if(url === "/api/content"){
      if(m === "GET") return needAuth(req, res, false).then(function(s){ if(!s) return; return Promise.all([loadContentText(), loadMeta()]).then(function(r){ var h = { "X-Content-Version": String(r[1].version) }; if(s.refresh) h["Set-Cookie"] = cookieHeader(makeToken(s.username, { updatedAt: s.credStamp }, s.csrf), SESSION_TTL / 1000, isSecureReq(req)); send(res, 200, r[0], "application/json; charset=utf-8", Object.assign({ "Cache-Control": "no-store" }, h)); }); });
      if(m === "PUT" || m === "POST") return needAuth(req, res, true).then(function(s){
        if(!s) return;
        return readBody(req, CAP_CONTENT).then(function(raw){
          var parsed; try { parsed = JSON.parse(raw); } catch(e){ return json(res, 400, { error: "JSON tidak valid: " + e.message }); }
          var errs = validateContent(parsed); if(errs.length) return json(res, 400, { error: "Struktur konten tidak valid.", details: errs });
          return loadMeta().then(function(meta){
            var base = req.headers["x-base-version"];
            if(base != null && base !== "" && String(meta.version) !== String(base)) return json(res, 409, { error: "Konten sudah diperbarui orang lain (kini versi " + meta.version + "). Muat ulang dulu.", currentVersion: meta.version });
            return publish(parsed, s.username, "publish content").then(function(r){ authedJson(req, res, s, 200, { ok: true, version: r.version, backup: r.backup }); }, function(e){ json(res, 500, { error: e.message }); });
          });
        });
      });
      return send(res, 405, "Method not allowed");
    }
    if(url.indexOf("/api/") === 0) return json(res, 404, { error: "Tidak ditemukan." });

    if(m !== "GET" && m !== "HEAD") return send(res, 405, "Method not allowed");
    if(url === "/admin" || url === "/admin/"){
      if(ADMIN_HTML == null) ADMIN_HTML = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
      return send(res, 200, ADMIN_HTML, "text/html; charset=utf-8", { "Cache-Control": "no-cache" });
    }
    if(PAGE_FOR[url]) return pageResponse(req, res, url);
    if(url === "/assets/content.js") return loadContent().then(function(d){
      var body = builder.contentJsSource(d), etag = '"' + crypto.createHash("sha1").update(body).digest("hex").slice(0, 16) + '"';
      if(req.headers["if-none-match"] === etag) return send(res, 304, "", "text/javascript; charset=utf-8", { ETag: etag, "Cache-Control": "public, max-age=0, s-maxage=5, must-revalidate" });
      send(res, 200, m === "HEAD" ? "" : body, "text/javascript; charset=utf-8", { ETag: etag, "Cache-Control": "public, max-age=0, s-maxage=5, must-revalidate" });
    });
    var up = url.match(/^\/assets\/images\/uploads\/([^\/]+)$/);
    if(up){
      var name = up[1]; if(!UPLOAD_RE.test(name)) return send(res, 404, "Not found");
      return store.getBuffer("uploads/" + name).then(function(f){
        if(!f) return send(res, 404, "Not found");
        send(res, 200, m === "HEAD" ? "" : f.buffer, MIME[name.split(".").pop().toLowerCase()] || f.contentType || "application/octet-stream", { "Cache-Control": "public, max-age=3600, s-maxage=300", "X-Content-Type-Options": "nosniff" });
      });
    }
    return send(res, 404, "Not found");
  }

  return function handler(req, res){
    var u; try { u = new URL(req.url, "http://localhost"); } catch(e){ return send(res, 400, "Bad request"); }
    var url = u.searchParams.get("_p") || u.pathname; u.searchParams.delete("_p");
    var query = {}; u.searchParams.forEach(function(v, k){ query[k] = v; });
    try { url = decodeURIComponent(url); } catch(e){ return send(res, 404, "Not found"); }
    var done;
    try { done = Promise.resolve(route(req, res, url, query)); } catch(e){ done = Promise.reject(e); }
    return done.catch(function(e){
      if(res.headersSent) { try { res.end(); } catch(x){} return; }
      if(e && e.status) return json(res, e.status, { error: e.msg || "Permintaan tidak valid." });
      console.error("[cms]", e && e.stack || e);
      json(res, 500, { error: "Terjadi kesalahan pada server." });
    });
  };
}

module.exports = { createHandler: createHandler };
