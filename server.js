// Neon Körfez — oyun + çok oyunculu sunucu (37dervis)
// Çalıştır: npm install && npm start   (varsayılan port 3000)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;             // cPanel/Passenger kendi verir
const HOST = process.env.HOST || '0.0.0.0';   // Render vb. için dışarıya açık; VPS'te servis dosyası 127.0.0.1 verir
const PUB = path.join(__dirname, 'public');
const MAX_ROOM = Number(process.env.MAX_ROOM) || 32; // oda başına oyuncu
const TOPICS = new Set(['shot', 'hit', 'kill', 'chat']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

// ---- statik dosyalar ----
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url.endsWith('/health')) { res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }); return res.end('ok ' + wss.clients.size + ' oyuncu'); }
  let p;
  try { p = decodeURIComponent(url); } catch { res.writeHead(400); return res.end(); }
  if (p === '' || p.endsWith('/')) p = '/index.html';
  else if (!path.extname(p)) p = '/index.html';
  else p = '/' + path.basename(p);           // alt klasörde (ör. /oyun/) çalışsa da bulur
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Bulunamadı'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---- çok oyunculu ----
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const u = (req.url || '').split('?')[0];
  if (!u.endsWith('/ws')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
const rooms = new Map();
let seq = 0;
const newId = () => (Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  for (const c of room) if (c !== except && c.readyState === 1) c.send(s);
}

wss.on('connection', ws => {
  ws.id = newId(); ws.room = null; ws.presence = {}; ws.alive = true;
  ws.budget = 80; ws.last = Date.now();
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', buf => {
    // saniyede ~40 mesaj sınırı (80'lik patlama payı)
    const now = Date.now();
    ws.budget = Math.min(80, ws.budget + (now - ws.last) * 0.04); ws.last = now;
    if (ws.budget < 1) return; ws.budget--;

    let m; try { m = JSON.parse(buf); } catch { return; }
    if (!isObj(m)) return;

    if (m.t === 'join') {
      if (ws.room) return;
      const name = String(m.room || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 48) || 'nk-sehir';
      let room = rooms.get(name);
      if (!room) { room = new Set(); rooms.set(name, room); }
      if (room.size >= MAX_ROOM) { ws.send(JSON.stringify({ t: 'full' })); return ws.close(); }
      ws.room = room; ws.roomName = name;
      ws.presence = isObj(m.p) ? m.p : {};
      ws.send(JSON.stringify({ t: 'hello', you: ws.id, peers: [...room].map(c => ({ peer: c.id, p: c.presence })) }));
      room.add(ws);
      broadcast(room, { t: 'join', peer: ws.id, p: ws.presence }, ws);
      return;
    }
    if (!ws.room) return;

    if (m.t === 'p' && isObj(m.p)) {
      for (const k in m.p) { if (m.p[k] === null) delete ws.presence[k]; else ws.presence[k] = m.p[k]; }
      if (JSON.stringify(ws.presence).length > 4096) { ws.presence = {}; return; }
      broadcast(ws.room, { t: 'p', peer: ws.id, p: m.p }, ws);
      return;
    }
    if (m.t === 'e' && TOPICS.has(m.topic)) {
      broadcast(ws.room, { t: 'e', topic: m.topic, peer: ws.id, d: m.d }); // gönderene de döner (oyun buna güveniyor)
    }
  });

  ws.on('close', () => {
    const room = ws.room; if (!room) return;
    room.delete(ws);
    broadcast(room, { t: 'left', peer: ws.id });
    if (!room.size) rooms.delete(ws.roomName);
  });
});

// kopan bağlantıları temizle
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
}, 30000);

const done = () => console.log(`Neon Körfez sunucusu çalışıyor (${PORT})  WebSocket: /ws`);
if (typeof PhusionPassenger !== 'undefined') server.listen('passenger', done);          // cPanel "Setup Node.js App"
else if (isNaN(Number(PORT))) server.listen(PORT, done);                                    // soket yolu
else server.listen(Number(PORT), HOST, done);
