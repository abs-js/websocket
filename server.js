"use strict";
/**
 * School Soccer — lobby + partida
 * Cada cliente manda: jogadores do SEU time, quem controla, ações.
 * Servidor guarda a bola (posição, velocidade, dono) e devolve o mundo.
 */
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const BETS = [0, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
const K_FACTOR = 32;
const SYNC_HZ_MAX = 30;
const FW = 1750;
const FH = 1000;
const GOAL_Y = 388;
const GOAL_H = 224;

const clients = new Map();
const byId = new Map();
const rooms = new Map();
const ratings = new Map();

function eloExpected(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}
function eloDelta(ra, rb, scoreA) {
  return Math.round(K_FACTOR * (scoreA - eloExpected(ra, rb)));
}
function uid(n) {
  return crypto.randomBytes(n || 4).toString("hex");
}
function getRating(id) {
  if (!ratings.has(id)) ratings.set(id, 800);
  return ratings.get(id);
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.id = uid(6);
    this.profile = { name: "Técnico", team: "Clube", ovr: 55, wins: 0, losses: 0, xp: 0, rating: 800, coins: 0 };
    this.roomId = null;
    this.lastInputAt = 0;
  }
  send(obj) {
    if (this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }
}

function blankBall() {
  return { x: FW / 2, y: FH / 2, vx: 0, vy: 0, h: 0, air: 0, hid: -1 };
}

class Room {
  constructor(host, opts) {
    this.id = uid(3);
    this.hostId = host.id;
    this.guestId = null;
    this.bet = BETS.includes(opts.bet) ? opts.bet : 0;
    this.friendly = !!opts.friendly || this.bet === 0;
    if (this.friendly) this.bet = 0;
    this.status = "waiting";
    this.createdAt = Date.now();
    this.hostReady = false;
    this.guestReady = false;
    this.world = {
      ball: blankBall(),
      plist: {},
      score: [0, 0],
      time: 180,
      act: "",
      actUntil: 0,
      ctrl: { 1: -1, 2: -1 },
      sp: null
    };
    this.loop = null;
    this.lockGoal = 0;
  }
  host() { return byId.get(this.hostId); }
  guest() { return this.guestId ? byId.get(this.guestId) : null; }
  peers() { return [this.host(), this.guest()].filter(Boolean); }
  broadcast(obj, exceptId) {
    this.peers().forEach(c => {
      if (c && c.id !== exceptId) c.send(obj);
    });
  }
  public() {
    const h = this.host();
    const g = this.guest();
    return {
      id: this.id,
      status: this.status,
      bet: this.bet,
      friendly: this.friendly,
      host: h ? { ...h.profile, id: h.id, rating: getRating(h.id) } : null,
      guest: g ? { ...g.profile, id: g.id, rating: getRating(g.id) } : null
    };
  }
  startLoop() {
    if (this.loop) return;
    this.loop = setInterval(() => tickRoom(this), 50);
  }
  stopLoop() {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }
}

function listRooms() {
  return [...rooms.values()].filter(r => r.status === "waiting").map(r => r.public());
}
function sendLobby() {
  const payload = { type: "rooms", rooms: listRooms() };
  clients.forEach(c => c.send(payload));
}
function leaveRoom(c, reason) {
  if (!c || !c.roomId) return;
  const room = rooms.get(c.roomId);
  c.roomId = null;
  if (!room) return;
  if (room.status === "playing") {
    const winnerIsHost = c.id !== room.hostId;
    finishMatch(room, winnerIsHost ? "host" : "guest", "disconnect");
    return;
  }
  if (c.id === room.hostId) {
    const g = room.guest();
    rooms.delete(room.id);
    if (g) {
      g.roomId = null;
      g.send({ type: "roomClosed", reason: reason || "host_left" });
    }
  } else if (c.id === room.guestId) {
    room.guestId = null;
    room.guestReady = false;
    const h = room.host();
    if (h) h.send({ type: "room", you: "host", room: room.public() });
  }
  sendLobby();
}

function finishMatch(room, winner, reason) {
  if (!room || room.status !== "playing") return;
  room.status = "ended";
  room.stopLoop();
  const host = room.host();
  const guest = room.guest();
  const rh = host ? getRating(host.id) : 800;
  const rg = guest ? getRating(guest.id) : 800;
  let dh = 0, dg = 0;
  if (!room.friendly) {
    const sH = winner === "draw" ? 0.5 : (winner === "host" ? 1 : 0);
    dh = eloDelta(rh, rg, sH);
    dg = eloDelta(rg, rh, 1 - sH);
    if (host) ratings.set(host.id, Math.max(100, rh + dh));
    if (guest) ratings.set(guest.id, Math.max(100, rg + dg));
  }
  const payload = {
    type: "matchResult",
    winner,
    reason,
    friendly: room.friendly,
    bet: room.bet,
    score: room.world.score,
    rating: {
      host: host ? { before: rh, after: getRating(host.id), delta: dh } : null,
      guest: guest ? { before: rg, after: getRating(guest.id), delta: dg } : null
    }
  };
  room.peers().forEach(c => c.send(payload));
  rooms.delete(room.id);
  if (host) host.roomId = null;
  if (guest) guest.roomId = null;
  sendLobby();
}

function teamOfIndex(room, i) {
  const p = room.world.plist[i];
  return p ? p.t : 0;
}

function applySync(room, c, msg) {
  const team = c.id === room.hostId ? 1 : 2;
  if (Array.isArray(msg.players)) {
    msg.players.forEach(p => {
      const i = Number(p.i);
      if (!Number.isFinite(i)) return;
      room.world.plist[i] = {
        i,
        x: Number(p.x) || 0,
        y: Number(p.y) || 0,
        fx: Number(p.fx) || 0,
        fy: Number(p.fy) || 0,
        t: team,
        nm: String(p.nm || "")
      };
    });
  }
  if (Number.isInteger(msg.ctrl)) room.world.ctrl[team] = msg.ctrl;

  if (msg.sp) room.world.sp = msg.sp;
  else if (msg.sp === null && team === (room.world.sp && room.world.sp.team)) room.world.sp = null;

  const acts = Array.isArray(msg.acts) ? msg.acts : [];
  if (acts.length) {
    const last = acts[acts.length - 1];
    room.world.act = String(last.k || last || "");
    room.world.actUntil = Date.now() + 700;
  }

  const b = msg.ball;
  const claim = Number.isInteger(msg.claim) ? msg.claim : -1;
  const hid = room.world.ball.hid;
  const hidTeam = hid >= 0 ? teamOfIndex(room, hid) : 0;

  const releaseAct = acts.some(a => {
    const k = String((a && a.k) || a || "");
    return /shoot|pass|cross|release/i.test(k);
  });
  const wantFree = releaseAct || (b && (Number(b.hid) === -1 || Number(b.owner) === -1) && claim < 0);
  if (wantFree && b) {
    room.world.ball = {
      x: Number(b.x) || room.world.ball.x,
      y: Number(b.y) || room.world.ball.y,
      vx: Number(b.vx) || 0,
      vy: Number(b.vy) || 0,
      h: Number(b.h) || 0,
      air: b.air ? 1 : 0,
      hid: -1
    };
    return;
  }
  if (claim >= 0 && hid >= 0 && hidTeam && hidTeam !== team) {
    debugSelf("steal-attempt", { from: team, hid, claim });
  }
  if (claim >= 0 && teamOfIndex(room, claim) === team && (hid < 0 || hidTeam === team)) {
    room.world.ball.hid = claim;
    const p = room.world.plist[claim];
    if (p) {
      room.world.ball.x = p.x + (p.fx || 0) * 16;
      room.world.ball.y = p.y + (p.fy || 0) * 16;
      room.world.ball.vx = 0;
      room.world.ball.vy = 0;
      room.world.ball.air = 0;
    }
  }
  if (b && hidTeam === team) {
    room.world.ball.x = Number(b.x) || room.world.ball.x;
    room.world.ball.y = Number(b.y) || room.world.ball.y;
    room.world.ball.h = Number(b.h) || 0;
  }
}

function tickRoom(room) {
  if (room.status !== "playing") return;
  const ball = room.world.ball;
  if (Date.now() > room.world.actUntil) room.world.act = "";

  if (ball.hid >= 0 && room.world.plist[ball.hid]) {
    const p = room.world.plist[ball.hid];
    ball.x = p.x + (p.fx || 0) * 16;
    ball.y = p.y + (p.fy || 0) * 16;
    ball.vx = 0;
    ball.vy = 0;
    ball.air = 0;
  } else {
    ball.hid = -1;
    ball.x += ball.vx || 0;
    ball.y += ball.vy || 0;
    ball.vx *= 0.986;
    ball.vy *= 0.986;
    if (ball.y < 12) { ball.y = 12; ball.vy *= -0.55; }
    if (ball.y > FH - 12) { ball.y = FH - 12; ball.vy *= -0.55; }
    const inGoalY = ball.y >= GOAL_Y && ball.y <= GOAL_Y + GOAL_H;
    if (room.lockGoal <= 0 && !ball.air) {
      if (ball.x < 6 && inGoalY) {
        room.world.score[1] += 1;
        resetKick(room, 1);
      } else if (ball.x > FW - 6 && inGoalY) {
        room.world.score[0] += 1;
        resetKick(room, 2);
      }
    }
    if (ball.x < 10 && !inGoalY) { ball.x = 10; ball.vx *= -0.45; }
    if (ball.x > FW - 10 && !inGoalY) { ball.x = FW - 10; ball.vx *= -0.45; }
  }
  if (room.lockGoal > 0) room.lockGoal--;

  const players = Object.values(room.world.plist);
  const hid = room.world.ball.hid;
  room.broadcast({
    type: "world",
    ball: Object.assign({}, room.world.ball, { owner: hid }),
    players,
    score: room.world.score,
    time: room.world.time,
    owner: hid,
    ctrl: room.world.ctrl,
    sp: room.world.sp
  });
}

function resetKick(room, kickTeam) {
  room.world.ball = blankBall();
  room.world.sp = null;
  room.lockGoal = 40;
  room.world.act = "GOL";
  room.world.actUntil = Date.now() + 1500;
}

const server = http.createServer((req, res) => {
  if ((req.url || "").startsWith("/debug")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, lastSelf: lastSelfDebug, recent: serverDebug.slice(-20), rooms: rooms.size, clients: clients.size }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("School Soccer WS ok\n");
});
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const c = new Client(ws);
  clients.set(ws, c);
  byId.set(c.id, c);
  c.send({ type: "welcome", playerId: c.id, rooms: listRooms() });
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch (e) { return; }
    handle(c, msg);
  });
  ws.on("close", () => {
    leaveRoom(c, "disconnect");
    clients.delete(ws);
    byId.delete(c.id);
  });
});

const serverDebug = [];
let lastSelfDebug = null;
function debugSelf(kind, data) {
  const ev = { t: Date.now(), kind: String(kind || "log"), data: data || {} };
  serverDebug.push(ev);
  if (serverDebug.length > 100) serverDebug.shift();
  lastSelfDebug = ev;
  process.emit("soccer-debug", ev);
}
process.on("soccer-debug", (ev) => {
  lastSelfDebug = ev;
});
setInterval(() => {
  const payload = {
    type: "debug",
    self: true,
    rooms: rooms.size,
    clients: clients.size,
    uptime: Math.round(process.uptime())
  };
  debugSelf("heartbeat", payload);
  handle(null, payload);
}, 4000);

function handle(c, msg) {
  switch (msg.type) {
    case "hello": {
      const p = msg.profile || {};
      c.profile.name = String(p.name || c.profile.name).slice(0, 24);
      c.profile.team = String(p.team || c.profile.team).slice(0, 24);
      c.profile.ovr = Number(p.ovr) || 55;
      c.profile.wins = Number(p.wins) || 0;
      c.profile.losses = Number(p.losses) || 0;
      c.profile.xp = Number(p.xp) || 0;
      c.profile.coins = Number(p.coins) || 0;
      if (p.rating) {
        const cur = getRating(c.id);
        ratings.set(c.id, Math.round((cur + Number(p.rating)) / 2));
      }
      c.profile.rating = getRating(c.id);
      c.send({ type: "profileOk", playerId: c.id, rating: c.profile.rating });
      break;
    }
    case "list":
      c.send({ type: "rooms", rooms: listRooms() });
      break;
    case "create": {
      if (c.roomId) leaveRoom(c, "recreate");
      const bet = Number(msg.bet) || 0;
      const friendly = !!msg.friendly || bet === 0;
      if (!friendly && !BETS.includes(bet)) {
        c.send({ type: "error", msg: "Aposta inválida." });
        return;
      }
      if (!friendly && (c.profile.coins || 0) < bet) {
        c.send({ type: "error", msg: "Moedas insuficientes para essa aposta." });
        return;
      }
      const room = new Room(c, { bet: friendly ? 0 : bet, friendly });
      rooms.set(room.id, room);
      c.roomId = room.id;
      c.send({ type: "room", you: "host", room: room.public() });
      sendLobby();
      break;
    }
    case "join": {
      const room = rooms.get(String(msg.roomId || ""));
      if (!room || room.status !== "waiting") {
        c.send({ type: "error", msg: "Sala não disponível." });
        return;
      }
      if (room.guestId || room.hostId === c.id) {
        c.send({ type: "error", msg: "Não foi possível entrar." });
        return;
      }
      if (!room.friendly && (c.profile.coins || 0) < room.bet) {
        c.send({ type: "error", msg: "Moedas insuficientes para a aposta da sala." });
        return;
      }
      room.guestId = c.id;
      c.roomId = room.id;
      room.broadcast({ type: "room", room: room.public() });
      sendLobby();
      break;
    }
    case "ready": {
      const room = rooms.get(c.roomId);
      if (!room || room.status !== "waiting") return;
      if (c.id === room.hostId) room.hostReady = true;
      if (c.id === room.guestId) room.guestReady = true;
      room.broadcast({ type: "readyState", host: room.hostReady, guest: room.guestReady, room: room.public() });
      if (room.hostReady && room.guestReady && room.guestId) {
        room.status = "playing";
        room.world.ball = blankBall();
        room.world.score = [0, 0];
        room.startLoop();
        const seed = Date.now() % 1e9;
        const host = room.host();
        const guest = room.guest();
        if (host) host.send({ type: "matchStart", you: "host", team: 1, seed, room: room.public() });
        if (guest) guest.send({ type: "matchStart", you: "guest", team: 2, seed, room: room.public() });
        sendLobby();
      }
      break;
    }
    case "lineup": {
      const room = rooms.get(c.roomId);
      if (!room) return;
      const other = c.id === room.hostId ? room.guest() : room.host();
      if (other) other.send({ type: "lineup", from: c.id, players: Array.isArray(msg.players) ? msg.players : [] });
      break;
    }
    case "sync":
    case "input": {
      const room = rooms.get(c.roomId);
      if (!room || room.status !== "playing") return;
      const now = Date.now();
      if (now - c.lastInputAt < (1000 / SYNC_HZ_MAX) - 2 && !(msg.acts && msg.acts.length)) return;
      c.lastInputAt = now;
      applySync(room, c, msg.input || msg);
      break;
    }
    case "state":
      break;
    case "matchEnd": {
      const room = rooms.get(c.roomId);
      if (!room || room.status !== "playing") return;
      const s1 = Number(msg.scoreHost != null ? msg.scoreHost : room.world.score[0]) || 0;
      const s2 = Number(msg.scoreGuest != null ? msg.scoreGuest : room.world.score[1]) || 0;
      room.world.score = [s1, s2];
      const winner = s1 === s2 ? "draw" : (s1 > s2 ? "host" : "guest");
      finishMatch(room, winner, "fulltime");
      break;
    }
    case "leave":
      leaveRoom(c, "leave");
      break;
    case "debug": {
      if (!c) {
        debugSelf("loopback", { rooms: rooms.size, clients: clients.size });
        break;
      }
      const room = c.roomId ? rooms.get(c.roomId) : null;
      c.send({
        type: "debug",
        self: false,
        you: c.id,
        room: room ? room.id : null,
        ball: room ? room.world.ball : null,
        lastSelf: lastSelfDebug,
        recent: serverDebug.slice(-8)
      });
      debugSelf("client-debug", { id: c.id, room: c.roomId });
      break;
    }
    default:
      debugSelf("unknown", { type: msg && msg.type, from: c && c.id });
      break;
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("School Soccer WS on :" + PORT);
});
