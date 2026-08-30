"use strict";
/**
 * School Soccer — online lobby + match relay
 * Host-authoritative: the room host simulates and broadcasts snapshots.
 * Guest sends inputs. Server validates bets, Elo and disconnects.
 */
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const BETS = [0, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
const K_FACTOR = 32;
const INPUT_HZ_MAX = 40;

const clients = new Map(); // ws -> Client
const byId = new Map();    // playerId -> Client
const rooms = new Map();   // roomId -> Room
const ratings = new Map(); // playerId -> number

function eloExpected(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}
function eloDelta(ra, rb, scoreA) {
  const exp = eloExpected(ra, rb);
  return Math.round(K_FACTOR * (scoreA - exp));
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
    this.profile = {
      name: "Técnico",
      team: "Clube",
      ovr: 55,
      wins: 0,
      losses: 0,
      xp: 0,
      rating: 800,
      coins: 0
    };
    this.roomId = null;
    this.lastInputAt = 0;
  }
  send(obj) {
    if (this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }
}

class Room {
  constructor(host, opts) {
    this.id = uid(3);
    this.hostId = host.id;
    this.guestId = null;
    this.bet = BETS.includes(opts.bet) ? opts.bet : 0;
    this.friendly = !!opts.friendly || this.bet === 0;
    if (this.friendly) this.bet = 0;
    this.status = "waiting"; // waiting | playing | ended
    this.createdAt = Date.now();
    this.hostReady = false;
    this.guestReady = false;
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
}

function listRooms() {
  return [...rooms.values()]
    .filter(r => r.status === "waiting")
    .map(r => r.public());
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
    room.status = "waiting";
    const h = room.host();
    if (h) h.send({ type: "opponentLeft", reason: reason || "guest_left", room: room.public() });
  }
  sendLobby();
}
function finishMatch(room, winnerSide, why) {
  if (!room || room.status === "ended") return;
  room.status = "ended";
  const host = room.host();
  const guest = room.guest();
  const hostR = host ? getRating(host.id) : 800;
  const guestR = guest ? getRating(guest.id) : 800;
  const hostWon = winnerSide === "host";
  const draw = winnerSide === "draw";
  let dHost = 0, dGuest = 0;
  if (!room.friendly && !draw) {
    dHost = eloDelta(hostR, guestR, hostWon ? 1 : 0);
    dGuest = eloDelta(guestR, hostR, hostWon ? 0 : 1);
    if (host) ratings.set(host.id, Math.max(100, hostR + dHost));
    if (guest) ratings.set(guest.id, Math.max(100, guestR + dGuest));
  } else if (!room.friendly && draw) {
    dHost = eloDelta(hostR, guestR, 0.5);
    dGuest = eloDelta(guestR, hostR, 0.5);
    if (host) ratings.set(host.id, Math.max(100, hostR + dHost));
    if (guest) ratings.set(guest.id, Math.max(100, guestR + dGuest));
  }
  const pot = room.bet * 2;
  const result = {
    type: "matchOver",
    why: why || "fulltime",
    winner: draw ? "draw" : winnerSide,
    friendly: room.friendly,
    bet: room.bet,
    pot: room.friendly ? 0 : pot,
    rating: {
      host: { before: hostR, delta: dHost, after: host ? getRating(host.id) : hostR },
      guest: { before: guestR, delta: dGuest, after: guest ? getRating(guest.id) : guestR }
    }
  };
  room.broadcast(result);
  if (host) host.roomId = null;
  if (guest) guest.roomId = null;
  rooms.delete(room.id);
  sendLobby();
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      name: "School Soccer WS",
      rooms: rooms.size,
      players: clients.size
    }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const c = new Client(ws);
  clients.set(ws, c);
  byId.set(c.id, c);
  c.send({
    type: "welcome",
    playerId: c.id,
    rating: getRating(c.id),
    bets: BETS.filter(b => b > 0),
    rooms: listRooms()
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch (e) { return; }
    if (!msg || typeof msg.type !== "string") return;
    handle(c, msg);
  });
  ws.on("close", () => {
    leaveRoom(c, "disconnect");
    byId.delete(c.id);
    clients.delete(ws);
  });
  ws.on("error", () => {});
});

function handle(c, msg) {
  switch (msg.type) {
    case "hello": {
      const p = msg.profile || {};
      c.profile = {
        name: String(p.name || "Técnico").slice(0, 24),
        team: String(p.team || "Clube").slice(0, 24),
        ovr: Math.max(1, Math.min(99, Number(p.ovr) || 55)),
        wins: Math.max(0, Number(p.wins) || 0),
        losses: Math.max(0, Number(p.losses) || 0),
        xp: Math.max(0, Number(p.xp) || 0),
        rating: getRating(c.id),
        coins: Math.max(0, Number(p.coins) || 0)
      };
      if (Number(p.rating) >= 100 && Number(p.rating) <= 3000) {
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
    case "input": {
      const room = rooms.get(c.roomId);
      if (!room || room.status !== "playing") return;
      const now = Date.now();
      if (now - c.lastInputAt < (1000 / INPUT_HZ_MAX) - 2) return;
      c.lastInputAt = now;
      // Guest inputs go to host; host inputs (optional) go to guest for prediction
      const other = c.id === room.hostId ? room.guest() : room.host();
      if (other) other.send({ type: "input", from: c.id, input: msg.input || {} });
      break;
    }
    case "state": {
      const room = rooms.get(c.roomId);
      if (!room || room.status !== "playing") return;
      if (c.id !== room.hostId) return; // only host simulates
      const g = room.guest();
      if (g) g.send({ type: "state", state: msg.state });
      break;
    }
    case "matchEnd": {
      const room = rooms.get(c.roomId);
      if (!room || room.status !== "playing") return;
      if (c.id !== room.hostId) return;
      const s1 = Number(msg.scoreHost) || 0;
      const s2 = Number(msg.scoreGuest) || 0;
      const winner = s1 === s2 ? "draw" : (s1 > s2 ? "host" : "guest");
      finishMatch(room, winner, "fulltime");
      break;
    }
    case "leave":
      leaveRoom(c, "leave");
      break;
    default:
      break;
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("School Soccer WS on :" + PORT);
});
