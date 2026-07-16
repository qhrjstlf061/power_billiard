"use strict";

/* =========================================================
   4구 당구 백엔드 — Express + Socket.IO
   R0: 서버가 방 명단뿐 아니라 게임 세션 상태(설정·점수·턴·좌표
   스냅샷)를 기록한다. 물리는 여전히 클라이언트 양쪽이 계산하고,
   서버는 릴레이하면서 상태를 "기록"만 한다 (재접속 R1의 기반).
   ========================================================= */
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const db = require("./db");       // B3: 전적/랭킹 (내장 SQLite)
const judge = require("./judge"); // B4: 서버 권위 판정

const app = express();
const server = http.createServer(app);

// R4: CORS — 배포 시 ALLOWED_ORIGINS="https://내주소1,https://내주소2"로 축소.
// 미설정(로컬 개발)이면 전체 허용. 같은 서버에서 클라이언트를 서빙하면 CORS 자체가 필요 없음.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true },
  // cors 옵션은 브라우저용 헤더만 제어하므로, 목록이 있으면 handshake 자체를 거부
  allowRequest: (req, callback) => {
    if (!ALLOWED_ORIGINS.length) return callback(null, true);
    const origin = req.headers.origin;
    if (!origin) return callback(null, true); // Origin 없는 요청(헬스체크 등)
    // 서버가 직접 서빙한 페이지(같은 host)는 목록과 무관하게 항상 허용 —
    // 브라우저는 same-origin WebSocket에도 Origin을 붙이므로 이 예외가 없으면 자기 자신이 차단됨
    try {
      if (new URL(origin).host === req.headers.host) return callback(null, true);
    } catch (e) { /* 이상한 Origin은 목록 검사로 */ }
    callback(null, ALLOWED_ORIGINS.includes(origin));
  }
});

app.use(express.static(path.join(__dirname, "..", "client")));

/* ---------- 방 & 세션 상태 ---------- */
// code -> {
//   code, createdAt,
//   players: [ { token, socketId, connected } | null, ... ]  (0=호스트, 1=게스트)
//   state: { phase, targetScore, scores, currentPlayer, turnNo, lastSync }
// }
const rooms = new Map();

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 혼동 문자(I,O,0,1) 제외
function makeCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function newState() {
  return {
    phase: "waiting",     // waiting(게스트 대기) / playing / ended
    targetScore: null,
    scores: [0, 0],
    currentPlayer: 0,
    turnNo: 0,
    lastSync: null        // 마지막 샷 종료 시 공 좌표 [[x,y],...] (호스트 기준)
  };
}

// B3: 게임 결과를 전적 DB에 기록 (게임당 1회, 익명(구버전)·자가 대전은 제외)
function recordMatchSafe(room, winnerIdx, forfeit) {
  if (room.recorded || winnerIdx < 0) return;
  const w = room.players[winnerIdx], l = room.players[1 - winnerIdx];
  if (!w || !l || !w.uid || !l.uid || w.uid === l.uid) return;
  room.recorded = true;
  const s = room.state.scores;
  db.recordMatch(
    { uid: w.uid, nick: w.nick, score: s[winnerIdx] },
    { uid: l.uid, nick: l.nick, score: s[1 - winnerIdx] },
    forfeit
  );
}

// 릴레이하며 세션 상태 기록. 물리 결과는 해석하지 않고 호스트가 보낸 값을 그대로 저장.
// (B4 enforce 모드에서만 judge가 이 값을 서버 시뮬레이션 결과로 덮어씀)
function recordState(room, msg, idx) {
  const st = room.state;
  switch (msg.t) {
    case "start":
      st.phase = "playing";
      st.targetScore = Number.isFinite(msg.target) ? msg.target : st.targetScore;
      st.scores = [0, 0];
      st.currentPlayer = 0;
      st.turnNo = 0;
      st.lastSync = null;
      room.recorded = false; // 새 게임 — 전적 기록 가능
      break;
    case "shot":
      if (Number.isFinite(msg.turn)) st.turnNo = msg.turn;
      break;
    case "sync": // 호스트의 샷 종료 좌표 스냅샷
      if (Array.isArray(msg.b)) st.lastSync = msg.b;
      break;
    case "state": // 호스트가 판정 직후 보내는 확정 상태 (점수·턴·다음 차례)
      if (Array.isArray(msg.s)) st.scores = msg.s.map(Number);
      if (Number.isFinite(msg.cp)) st.currentPlayer = msg.cp;
      if (Number.isFinite(msg.turn)) st.turnNo = msg.turn;
      if (msg.over) {
        st.phase = "ended";
        recordMatchSafe(room, st.scores[0] > st.scores[1] ? 0 : 1, false); // 목표 선취자 = 승자
      }
      break;
    case "rematch":
      st.phase = "playing";
      st.scores = [0, 0];
      st.currentPlayer = 0;
      st.turnNo = 0;
      st.lastSync = null;
      room.recorded = false;
      break;
    case "bye": // 게임 중 나가기 = 몰수패
      if (st.phase === "playing" && idx >= 0) recordMatchSafe(room, 1 - idx, true);
      st.phase = "ended";
      break;
  }
}

/* ---------- R1: 퇴장 & 끊김 유예 ---------- */
const GRACE_SEC = Number(process.env.GRACE_SEC) || 60; // 재접속 유예 (테스트에서 단축 가능)

function clearGraceTimers(room) {
  room.players.forEach(p => { if (p && p.graceTimer) { clearTimeout(p.graceTimer); p.graceTimer = null; } });
}

function teardown(room) {
  clearGraceTimers(room);
  rooms.delete(room.code);
}

// 의도적 퇴장(메뉴로 나가기, 새 방 만들기): 유예 없이 즉시 정리
function leaveRoom(socket) {
  const code = socket.data.code;
  if (!code) return;
  socket.data.code = null;
  socket.leave(code);
  const room = rooms.get(code);
  if (!room) return;
  socket.to(code).emit("peer-left");
  const idx = room.players.findIndex(p => p && p.socketId === socket.id);
  // B3: 게임 중 이탈(bye 없이 leave만 온 경우 포함) = 몰수패로 기록
  if (idx >= 0 && room.state.phase === "playing" && room.players[0] && room.players[1]) {
    recordMatchSafe(room, 1 - idx, true);
  }
  if (idx === 0) teardown(room); // 호스트가 나가면 방 자체를 제거
  else if (idx === 1) {
    // 게임 중이던 방에 새 게스트가 이어받아 들어오지 않도록 상태 초기화
    room.players[1] = null;
    room.state = newState();
  }
}

// 갑작스러운 끊김(disconnect): 게임 중이면 즉시 끝내지 않고 유예를 두고 기다림
function dropPlayer(socket) {
  const code = socket.data.code;
  if (!code) return;
  socket.data.code = null;
  const room = rooms.get(code);
  if (!room) return;
  const idx = room.players.findIndex(p => p && p.socketId === socket.id);
  if (idx < 0) return;

  if (room.state.phase !== "playing" || !room.players[0] || !room.players[1]) {
    // 대기/종료 중이면 기존 방식대로 즉시 정리
    socket.to(code).emit("peer-left");
    if (idx === 0) teardown(room);
    else { room.players[1] = null; room.state = newState(); }
    return;
  }

  const pl = room.players[idx];
  pl.connected = false;
  pl.socketId = null;
  pl.graceUntil = Date.now() + GRACE_SEC * 1000;
  socket.to(code).emit("peer-dropped", { graceSec: GRACE_SEC });

  pl.graceTimer = setTimeout(() => {
    if (rooms.get(code) !== room) return; // 이미 정리된 방
    // 유예 초과 → 몰수: 남아 있는 쪽에 승리 통지 + 전적 기록(B3) 후 방 정리
    if (room.state.phase === "playing") recordMatchSafe(room, 1 - idx, true);
    const other = room.players[1 - idx];
    if (other && other.connected && other.socketId) io.to(other.socketId).emit("forfeit-win");
    teardown(room);
  }, GRACE_SEC * 1000);
}

function snapshot(room) {
  const st = room.state;
  return {
    targetScore: st.targetScore,
    scores: st.scores,
    currentPlayer: st.currentPlayer,
    turnNo: st.turnNo,
    balls: st.lastSync // 마지막 확정 샷 종료 좌표 (없으면 null → 기본 배치)
  };
}

/* ---------- R2: 프로토콜 방어 ---------- */
const PROTOCOL_VERSION = 2;   // R1(resume) 반영 — 클라 net.js와 일치해야 함
const MAX_ROOMS = 200;        // 방 생성 폭주 방지

// 메시지 스키마 검증 — 클라 게임 상수 기준 (force 100~800, spin ±0.75, 공 4개)
const num = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const VALIDATORS = {
  hello: (m) => (m.v === undefined || num(m.v, 0, 1e6))
    && (m.n === undefined || (typeof m.n === "string" && m.n.length <= 12)),
  start: (m) => num(m.target, 1, 500),
  aim: (m) => num(m.a, -10, 10) && num(m.sx, -0.76, 0.76) && num(m.sy, -0.76, 0.76) && num(m.g, 0, 1),
  shot: (m) => num(m.turn, 1, 1e9) && !!m.p && typeof m.p === "object"
    && num(m.p.angle, -10, 10) && num(m.p.force, 99.9, 800.1)
    && num(m.p.spinX, -0.76, 0.76) && num(m.p.spinY, -0.76, 0.76)
    && (m.p.frac === undefined || num(m.p.frac, 0, 1)),
  sync: (m) => Array.isArray(m.b) && m.b.length === 4
    && m.b.every(p => Array.isArray(p) && p.length === 2 && num(p[0], -10, 10) && num(p[1], -10, 10)),
  state: (m) => Array.isArray(m.s) && m.s.length === 2 && m.s.every(x => num(x, 0, 10000))
    && num(m.cp, 0, 1) && num(m.turn, 0, 1e9) && (m.over === undefined || typeof m.over === "boolean"),
  rematch: () => true,
  bye: () => true,
  // F1: 프리롬 이동 (연출 전용 — 세션 상태에 기록하지 않음). e = 시선 yaw (선택)
  move: (m) => num(m.x, -12, 12) && num(m.z, -12, 12) && num(m.yaw, -10, 10)
    && typeof m.m === "boolean" && (m.e === undefined || num(m.e, -0.71, 0.71))
};

// 역할·턴 검증 — 서버가 세션 상태(R0)를 아는 덕분에 가능
function allowedRole(room, idx, m) {
  const st = room.state;
  switch (m.t) {
    case "start": case "sync": case "state":
      return idx === 0; // 호스트(심판) 전용
    case "shot":
      // 자기 차례 + 다음 턴 번호만 허용 (중복/재전송 샷도 차단)
      return st.currentPlayer === idx && m.turn === st.turnNo + 1;
    case "aim":
      return st.currentPlayer === idx;
    case "move": // 프리롬은 반대로 — 기다리는 쪽만 돌아다닐 수 있음
      return st.currentPlayer !== idx;
    default:
      return true; // hello / rematch / bye는 양쪽 다 가능
  }
}

// 토큰 버킷 레이트 리밋 (소켓별·종류별)
function allowRate(socket, kind, ratePerSec, burst) {
  const now = Date.now();
  const buckets = socket.data.buckets || (socket.data.buckets = {});
  const b = buckets[kind] || (buckets[kind] = { tokens: burst, last: now });
  b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 1000) * ratePerSec);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function logDrop(room, idx, m, why) {
  room.drops = (room.drops || 0) + 1;
  console.warn(`[방어] ${room.code.slice(0, 2)}**** p${idx} "${m.t}" 차단 (${why}) — 누적 ${room.drops}`);
}

/* ---------- R3: 방 수명 관리 ---------- */
const WAIT_TTL_SEC = Number(process.env.WAIT_TTL_SEC) || 600;   // 게스트 없는 대기 방
const IDLE_TTL_SEC = Number(process.env.IDLE_TTL_SEC) || 1800;  // 활동 없는 방 (게임 중 포함)
const SWEEP_MS = Number(process.env.SWEEP_MS) || 30000;

function touch(room) { room.touched = Date.now(); }

// 주기 청소: 방치된 방을 안내 후 정리 → 유령 방으로 코드가 점유되는 것 방지
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    const idleSec = (now - (room.touched || room.createdAt)) / 1000;
    const expired = (room.state.phase === "waiting" && idleSec > WAIT_TTL_SEC) || idleSec > IDLE_TTL_SEC;
    if (expired) {
      io.to(room.code).emit("room-expired");
      teardown(room);
    }
  }
}, SWEEP_MS).unref();

/* ---------- B2: 빠른 대전 대기열 ---------- */
const quickQueue = []; // 대기 중인 소켓들 (둘 모이면 자동 방 생성)

function dequeue(socket) {
  const i = quickQueue.indexOf(socket);
  if (i >= 0) quickQueue.splice(i, 1);
}

function createRoom(hostSocket, isPublic) {
  const code = makeCode();
  const token = crypto.randomBytes(12).toString("hex");
  rooms.set(code, {
    code,
    createdAt: Date.now(),
    touched: Date.now(),
    isPublic: !!isPublic,
    players: [{ token, socketId: hostSocket.id, connected: true, uid: hostSocket.data.uid || null, nick: hostSocket.data.nick || null }, null],
    state: newState()
  });
  hostSocket.join(code);
  hostSocket.data.code = code;
  return { code, token };
}

io.on("connection", (socket) => {
  // B3: 익명 계정 식별 — 브라우저가 만든 uid + 닉네임 (연결마다 다시 보냄)
  socket.on("identify", (data) => {
    if (!data || typeof data !== "object") return;
    if (!allowRate(socket, "id", 1, 5)) return;
    const uid = String(data.uid || "").slice(0, 64);
    let nick = String(data.nick || "").replace(/\s+/g, " ").trim().slice(0, 12);
    if (uid.length < 8) return;
    if (!nick) nick = "손님" + uid.slice(0, 4);
    socket.data.uid = uid;
    socket.data.nick = nick;
    db.upsertPlayer(uid, nick);
  });

  socket.on("host", (opts, ack) => {
    if (typeof opts === "function") { ack = opts; opts = {}; } // 옛 시그니처 호환
    if (typeof ack !== "function") return;
    if (!allowRate(socket, "room", 1, 3)) return ack({ ok: false, error: "rate" });
    if (rooms.size >= MAX_ROOMS) return ack({ ok: false, error: "server-full" });
    dequeue(socket);
    leaveRoom(socket);
    const { code, token } = createRoom(socket, opts && opts.public === true);
    ack({ ok: true, code, token });
  });

  // B2: 빠른 대전 — 대기열에 넣고 둘 모이면 자동으로 방 생성 (먼저 기다린 쪽 = 호스트)
  socket.on("quick", (ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!allowRate(socket, "room", 1, 3)) return reply({ ok: false, error: "rate" });
    if (rooms.size >= MAX_ROOMS) return reply({ ok: false, error: "server-full" });
    dequeue(socket);
    leaveRoom(socket);

    let partner = null;
    while (quickQueue.length) {
      const c = quickQueue.shift();
      if (c.connected && c !== socket) { partner = c; break; }
    }
    if (!partner) {
      quickQueue.push(socket);
      return reply({ ok: true, waiting: true });
    }

    const code = makeCode();
    const tokens = [crypto.randomBytes(12).toString("hex"), crypto.randomBytes(12).toString("hex")];
    rooms.set(code, {
      code,
      createdAt: Date.now(),
      touched: Date.now(),
      isPublic: false, // 매칭된 방은 목록에 노출할 필요 없음
      players: [
        { token: tokens[0], socketId: partner.id, connected: true, uid: partner.data.uid || null, nick: partner.data.nick || null },
        { token: tokens[1], socketId: socket.id, connected: true, uid: socket.data.uid || null, nick: socket.data.nick || null }
      ],
      state: newState()
    });
    partner.join(code); partner.data.code = code;
    socket.join(code); socket.data.code = code;
    reply({ ok: true, waiting: false });
    partner.emit("matched", { code, token: tokens[0], isHost: true });
    socket.emit("matched", { code, token: tokens[1], isHost: false });
  });

  socket.on("quick-cancel", () => dequeue(socket));

  socket.on("join", (code, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!allowRate(socket, "room", 1, 3)) return reply({ ok: false, error: "rate" });
    dequeue(socket);
    leaveRoom(socket);
    code = String(code || "").toUpperCase().trim().slice(0, 12);
    const room = rooms.get(code);
    if (!room) return reply({ ok: false, error: "no-room" });
    if (room.players[1]) return reply({ ok: false, error: "full" });
    const token = crypto.randomBytes(12).toString("hex");
    room.players[1] = { token, socketId: socket.id, connected: true, uid: socket.data.uid || null, nick: socket.data.nick || null };
    touch(room);
    socket.join(code);
    socket.data.code = code;
    reply({ ok: true, code, token });
    io.to(code).emit("ready"); // 두 명이 모였음 — 양쪽에 게임 시작 신호
  });

  socket.on("msg", (obj) => {
    const room = rooms.get(socket.data.code);
    if (!room || !obj || typeof obj !== "object" || typeof obj.t !== "string") return;
    const idx = room.players.findIndex(p => p && p.socketId === socket.id);
    if (idx < 0) return;

    // R2-3: 레이트 리밋 — aim/move는 실시간 스트림이라 여유 있게, 나머지는 빡빡하게
    if (obj.t === "aim" || obj.t === "move") { if (!allowRate(socket, obj.t, 15, 20)) return; }
    else if (!allowRate(socket, "msg", 10, 10)) return logDrop(room, idx, obj, "rate");

    // R2-1: 스키마 검증 — 모르는 타입, 범위 밖 값은 릴레이하지 않음
    const valid = VALIDATORS[obj.t];
    if (!valid || !valid(obj)) return logDrop(room, idx, obj, "schema");

    // R2-2: 역할·턴 검증 — 게스트의 start, 남의 턴 shot 등 차단
    if (!allowedRole(room, idx, obj)) return logDrop(room, idx, obj, "role/turn");

    // R2-4: 버전 핸드셰이크 — 불일치 클라이언트에 안내 (게임 시작 전 hello에서 걸러짐)
    if (obj.t === "hello" && obj.v !== PROTOCOL_VERSION) {
      socket.emit("version-mismatch", { server: PROTOCOL_VERSION, client: obj.v || 1 });
      return logDrop(room, idx, obj, "version");
    }

    recordState(room, obj, idx);
    touch(room);
    socket.to(room.code).emit("msg", obj);

    // B4: 서버 심판 — 샷을 직접 시뮬레이션하고 호스트의 보고와 대조
    if (obj.t === "start" || obj.t === "rematch") judge.onGameStart(room);
    else if (obj.t === "shot") judge.onShot(room, obj);
    else if (obj.t === "sync") judge.onSync(room, obj, io);
    else if (obj.t === "state") judge.onState(room, obj, io);
  });

  // R3: 연결 품질 측정 — 클라가 5초마다 왕복 시간을 잼
  socket.on("ping-check", (ack) => {
    if (typeof ack === "function" && allowRate(socket, "ping", 2, 5)) ack();
  });

  // R1: 재접속 — 저장해둔 (code, token)으로 끊겼던 자리에 복귀
  socket.on("resume", (data, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!allowRate(socket, "room", 1, 3)) return reply({ ok: false, error: "rate" });
    // R2-4: 복귀 경로에서도 버전 확인 (새로고침으로 옛 캐시가 로드된 경우)
    if (data && data.v !== undefined && data.v !== PROTOCOL_VERSION) return reply({ ok: false, error: "version" });
    dequeue(socket);
    leaveRoom(socket); // 다른 방에 걸쳐 있었다면 정리
    const code = String((data && data.code) || "").toUpperCase().trim().slice(0, 12);
    const room = rooms.get(code);
    if (!room || room.state.phase !== "playing") return reply({ ok: false, error: "expired" });
    const idx = room.players.findIndex(p => p && p.token === (data && data.token));
    if (idx < 0) return reply({ ok: false, error: "invalid" });
    const pl = room.players[idx];
    if (pl.connected) return reply({ ok: false, error: "already-connected" });

    clearTimeout(pl.graceTimer);
    pl.graceTimer = null;
    pl.graceUntil = null;
    pl.connected = true;
    pl.socketId = socket.id;
    touch(room);
    socket.join(code);
    socket.data.code = code;

    const other = room.players[1 - idx];
    const snap = snapshot(room);
    reply({
      ok: true,
      isHost: idx === 0,
      snap,
      peerConnected: !!(other && other.connected),
      graceLeft: other && !other.connected && other.graceUntil
        ? Math.max(0, Math.ceil((other.graceUntil - Date.now()) / 1000)) : 0
    });
    // 남아 있던 쪽도 같은 스냅샷으로 정렬 (끊김 중 밀린 상태 수렴)
    socket.to(code).emit("peer-resumed", { snap });
  });

  socket.on("leave", () => leaveRoom(socket));
  socket.on("disconnect", () => { dequeue(socket); dropPlayer(socket); });
});

/* ---------- REST: 방 목록 (B2) & 상태 조회 ---------- */
// GitHub Pages 등 다른 origin의 fetch를 위한 CORS 헤더 (허용 목록 기준)
function setCorsHeader(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
}

// 공개 대기 방 목록 — 공개 방의 코드는 목록 입장용이므로 노출이 곧 기능
app.get("/rooms", (req, res) => {
  setCorsHeader(req, res);
  res.json({
    rooms: [...rooms.values()]
      .filter(r => r.isPublic && r.state.phase === "waiting"
        && r.players[0] && r.players[0].connected && !r.players[1])
      .map(r => ({ code: r.code, ageSec: Math.round((Date.now() - r.createdAt) / 1000) }))
  });
});

// B3: 랭킹 (상위 10명) & 내 전적
app.get("/ranking", (req, res) => {
  setCorsHeader(req, res);
  res.json({ top: db.getRanking(10) });
});
app.get("/player", (req, res) => {
  setCorsHeader(req, res);
  const p = db.getPlayer(String(req.query.uid || ""));
  res.json({ ok: !!p, player: p });
});

// 초대 코드는 입장 자격이므로 그대로 노출하지 않고 마스킹한다
app.get("/health", (req, res) => {
  setCorsHeader(req, res);
  res.json({
    ok: true,
    version: PROTOCOL_VERSION,
    uptimeSec: Math.round(process.uptime()),
    quickQueue: quickQueue.length,
    judge: { mode: judge.MODE, ...judge.stats }, // B4: 판정 통계 (불일치 = 포트 오차 or 치트)
    rooms: [...rooms.values()].map(r => ({
      drops: r.drops || 0, // R2: 차단된 메시지 수
      idleSec: Math.round((Date.now() - (r.touched || r.createdAt)) / 1000),
      code: r.code.slice(0, 2) + "****",
      phase: r.state.phase,
      players: r.players.filter(p => p && p.connected).length,
      targetScore: r.state.targetScore,
      scores: r.state.scores,
      currentPlayer: r.state.currentPlayer,
      turnNo: r.state.turnNo,
      hasSnapshot: Array.isArray(r.state.lastSync),
      ageSec: Math.round((Date.now() - r.createdAt) / 1000)
    }))
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`4구 당구 서버 실행 중: http://localhost:${PORT}`);
});
