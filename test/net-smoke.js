"use strict";
/* 온라인 스모크 테스트 — 자체적으로 테스트 서버(3100, 유예 2초)를 띄우고 검증: npm test
   R0: 방/릴레이/세션 상태  ·  R1: 끊김 유예/재접속/몰수승  ·  R2: 스키마/턴/레이트/버전 방어 */
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const { io } = require("socket.io-client");
const Phys = require("../shared/physics");
const Rules = require("../shared/rules");

const PORT = 3100;
const GRACE_SEC = 2;
const WAIT_TTL_SEC = 2;  // 테스트용 단축 (실서비스 600)
const IDLE_TTL_SEC = 8;  // 테스트용 단축 (실서비스 1800) — 본 테스트 흐름을 방해하지 않을 만큼 길게
const PROTOCOL_VERSION = 2;
const URL = `http://localhost:${PORT}`;

const log = (s) => console.log(s);
let serverProc = null;
const fail = (s) => { console.error("FAIL: " + s); if (serverProc) serverProc.kill(); process.exit(1); };
const assert = (cond, s) => { if (!cond) fail(s); };
setTimeout(() => fail("timeout"), 40000);

const once = (sock, ev) => new Promise((res) => sock.once(ev, res));
const ack = (sock, ev, ...args) => new Promise((res) => sock.emit(ev, ...args, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = async () => (await fetch(URL + "/health")).json();

// send()가 보낸 메시지가 receiver에게 도달하지 "않아야" 통과 (서버 차단 확인)
async function expectDrop(send, receiver, why) {
  let got = null;
  const fn = (m) => { got = m; };
  receiver.on("msg", fn);
  send();
  await sleep(250);
  receiver.off("msg", fn);
  assert(!got, why + " — 차단돼야 하는데 릴레이됨: " + JSON.stringify(got));
}

async function startServer() {
  serverProc = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: {
      ...process.env, PORT: String(PORT), GRACE_SEC: String(GRACE_SEC),
      WAIT_TTL_SEC: String(WAIT_TTL_SEC), IDLE_TTL_SEC: String(IDLE_TTL_SEC), SWEEP_MS: "500",
      DB_PATH: path.join(os.tmpdir(), "billiard-test-" + Date.now() + ".db") // 테스트마다 새 DB
    },
    stdio: "ignore"
  });
  for (let i = 0; i < 40; i++) {
    try { await health(); return; } catch (e) { await sleep(100); }
  }
  fail("테스트 서버 기동 실패");
}

(async () => {
  await startServer();
  log("0. 테스트 서버 기동 OK (포트 " + PORT + ", 유예 " + GRACE_SEC + "초)");

  /* ========== R0: 기본 흐름 ========== */
  const host = io(URL);
  const guest = io(URL);

  const h = await ack(host, "host");
  assert(h.ok && h.code && h.token, "host: 코드/토큰 발급 실패");
  const readyBoth = Promise.all([once(host, "ready"), once(guest, "ready")]);
  const j = await ack(guest, "join", h.code);
  assert(j.ok && j.token, "join: 실패 또는 토큰 없음");
  await readyBoth;
  log("1. 방 생성 + 입장 + ready OK");

  const gotStart = once(guest, "msg");
  host.emit("msg", { t: "start", target: 30 });
  assert((await gotStart).t === "start", "start 릴레이 실패");
  let hs = await health();
  assert(hs.rooms.length === 1 && hs.rooms[0].phase === "playing" && hs.rooms[0].targetScore === 30, "R0: start 기록 실패");
  assert(!hs.rooms[0].code.includes(h.code.slice(2)), "R0: 코드가 마스킹돼야 함");
  log("2. start 릴레이 + 서버 기록 OK");

  // 정식 턴 순서: 호스트(선공) 샷 1 → 호스트가 sync + state 확정
  const gotShot = once(guest, "msg");
  host.emit("msg", { t: "shot", turn: 1, p: { angle: 0.5, force: 300, spinX: 0, spinY: 0 } });
  assert((await gotShot).t === "shot", "정상 shot 릴레이 실패");
  host.emit("msg", { t: "sync", turn: 1, b: [[0.1, 0.2], [1, 1], [2, 2], [3, 3]] });
  host.emit("msg", { t: "state", turn: 1, s: [10, 5], cp: 0, over: false });
  await sleep(200);
  hs = await health();
  assert(hs.rooms[0].turnNo === 1 && hs.rooms[0].scores[0] === 10 && hs.rooms[0].hasSnapshot, "R0: 세션 상태 기록 실패");
  log("3. 정상 샷 릴레이 + R0 세션 상태 기록 OK");

  /* ========== R2: 프로토콜 방어 ========== */
  // 역할 위반: 게스트의 start / 심판 메시지
  await expectDrop(() => guest.emit("msg", { t: "start", target: 20 }), host, "게스트 start");
  await expectDrop(() => guest.emit("msg", { t: "state", turn: 9, s: [99, 0], cp: 1 }), host, "게스트 state");
  // 턴 위반: 지금은 호스트 차례(cp=0)인데 게스트가 shot
  await expectDrop(() => guest.emit("msg", { t: "shot", turn: 2, p: { angle: 0, force: 300, spinX: 0, spinY: 0 } }), host, "남의 턴 shot");
  log("4. 역할·턴 위반 차단 OK (게스트 start/state, 남의 턴 shot)");

  // 스키마 위반: 힘 해킹, 순번 조작, 모르는 타입
  await expectDrop(() => host.emit("msg", { t: "shot", turn: 2, p: { angle: 0, force: 99999, spinX: 0, spinY: 0 } }), guest, "force 범위 밖");
  await expectDrop(() => host.emit("msg", { t: "shot", turn: 7, p: { angle: 0, force: 300, spinX: 0, spinY: 0 } }), guest, "턴 순번 건너뜀");
  await expectDrop(() => host.emit("msg", { t: "hack", x: 1 }), guest, "모르는 타입");
  hs = await health();
  assert(hs.rooms[0].drops >= 5, "차단 카운트가 기록돼야 함 (drops=" + hs.rooms[0].drops + ")");
  log("5. 스키마 위반 차단 OK (힘 해킹, 순번 조작, 모르는 타입) — 서버 drops=" + hs.rooms[0].drops);

  // 버전 핸드셰이크: 옛 버전 hello → version-mismatch 통지 + 릴레이 안 됨
  const vm = once(guest, "version-mismatch");
  guest.emit("msg", { t: "hello", v: 999 });
  const vmr = await vm;
  assert(vmr.server === PROTOCOL_VERSION, "version-mismatch에 서버 버전이 와야 함");
  log("6. 버전 불일치 감지 OK (서버 v" + vmr.server + " vs 클라 v999)");

  // 레이트 리밋: aim 100연발 → 버킷(15/s, 버스트 20) 수준만 통과
  let aimCount = 0;
  const countFn = (m) => { if (m.t === "aim") aimCount++; };
  guest.on("msg", countFn);
  for (let i = 0; i < 100; i++) host.emit("msg", { t: "aim", a: 0.1, sx: 0, sy: 0, g: 0 });
  await sleep(1000);
  guest.off("msg", countFn);
  assert(aimCount >= 10 && aimCount <= 45, "aim 폭주가 제한돼야 함 (통과=" + aimCount + "/100)");
  log("7. 레이트 리밋 OK — aim 100연발 중 " + aimCount + "개만 통과");

  // 방어가 정상 플레이는 막지 않는지: 턴 넘기고 게스트의 정당한 샷
  await sleep(1000); // 레이트 버킷 회복
  host.emit("msg", { t: "state", turn: 1, s: [10, 5], cp: 1, over: false }); // 게스트에게 턴
  await sleep(100);
  const gotShot2 = once(host, "msg");
  guest.emit("msg", { t: "shot", turn: 2, p: { angle: 1.1, force: 500, spinX: 0.2, spinY: -0.3 } });
  assert((await gotShot2).t === "shot", "정당한 게스트 shot이 릴레이돼야 함");
  host.emit("msg", { t: "sync", turn: 2, b: [[0.5, 0.5], [1, 1], [2, 2], [3, 3]] });
  host.emit("msg", { t: "state", turn: 2, s: [10, 5], cp: 0, over: false });
  await sleep(100);
  log("8. 방어 활성 상태에서 정상 플레이 영향 없음 OK");

  /* ========== R1: 끊김 유예 + 재접속 + 몰수승 ========== */
  const dropped = once(host, "peer-dropped");
  guest.disconnect();
  assert((await dropped).graceSec === GRACE_SEC, "peer-dropped에 유예 시간이 와야 함");
  log("9. 끊김 감지 OK — 방 유지 + 유예 통지");

  const guest2 = io(URL);
  const bad = await ack(guest2, "resume", { code: h.code, token: "wrong-token", v: PROTOCOL_VERSION });
  assert(!bad.ok && bad.error === "invalid", "잘못된 토큰은 거부돼야 함");
  const oldVer = await ack(guest2, "resume", { code: h.code, token: j.token, v: 1 });
  assert(!oldVer.ok && oldVer.error === "version", "옛 버전 resume은 거부돼야 함");
  log("10. 잘못된 토큰·옛 버전 resume 거부 OK");

  const resumedSeen = once(host, "peer-resumed");
  const r = await ack(guest2, "resume", { code: h.code, token: j.token, v: PROTOCOL_VERSION });
  assert(r.ok && r.isHost === false, "resume 실패");
  assert(r.snap.scores[0] === 10 && r.snap.turnNo === 2 && r.snap.balls[0][0] === 0.5, "resume 스냅샷 불일치");
  assert(r.peerConnected === true, "상대 연결 상태가 전달돼야 함");
  await resumedSeen;
  log("11. 재접속 OK — 점수·턴·좌표 복원 + 상대 통지");

  const forfeit = once(host, "forfeit-win");
  guest2.disconnect();
  await once(host, "peer-dropped");
  await forfeit;
  hs = await health();
  assert(hs.rooms.length === 0, "몰수 후 방이 정리돼야 함");
  log("12. 몰수승 OK — 유예 초과 시 승리 통지 + 방 정리");

  /* ========== 정리 흐름 회귀 확인 ========== */
  const guest3 = io(URL);
  const gone = await ack(guest3, "resume", { code: h.code, token: j.token, v: PROTOCOL_VERSION });
  assert(!gone.ok && gone.error === "expired", "정리된 방 복귀는 expired여야 함");
  const noRoom = await ack(guest3, "join", "XXXXXX");
  assert(!noRoom.ok && noRoom.error === "no-room", "없는 방은 거부돼야 함");
  const h2 = await ack(host, "host");
  assert(h2.ok, "재방 생성 실패");
  host.emit("leave");
  await sleep(200);
  hs = await health();
  assert(hs.rooms.length === 0, "의도적 퇴장(leave)은 즉시 정리돼야 함");
  log("13. 만료 복귀 거부 + 없는 방 거부 + 의도적 퇴장 즉시 정리 OK");

  /* ========== R3: 핑 + 방 수명 관리 ========== */
  const t0 = Date.now();
  await ack(host, "ping-check");
  log("14. ping-check OK — 왕복 " + (Date.now() - t0) + "ms");

  // 대기 방 TTL: 게스트 없이 방치 → 만료 통지 + 정리
  const waiter = io(URL);
  const hw = await ack(waiter, "host");
  assert(hw.ok, "대기 방 생성 실패");
  const expired = once(waiter, "room-expired");
  await expired;
  hs = await health();
  assert(hs.rooms.length === 0, "만료된 대기 방이 정리돼야 함");
  log("15. 대기 방 TTL OK — " + WAIT_TTL_SEC + "초 방치 → 만료 통지 + 정리");

  // 무활동 방 TTL: 게임 중이어도 오래 방치되면 정리
  const idleHost = io(URL);
  const idleGuest = io(URL);
  const hi = await ack(idleHost, "host");
  await ack(idleGuest, "join", hi.code);
  idleHost.emit("msg", { t: "start", target: 30 }); // phase=playing
  const idleExpired = Promise.all([once(idleHost, "room-expired"), once(idleGuest, "room-expired")]);
  await idleExpired;
  hs = await health();
  assert(hs.rooms.length === 0, "무활동 방이 정리돼야 함");
  log("16. 무활동 방 TTL OK — 게임 중 " + IDLE_TTL_SEC + "초 방치 → 양쪽 통지 + 정리");

  /* ========== R4: CORS 화이트리스트 ========== */
  const PORT2 = 3101;
  const cors = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], {
    env: { ...process.env, PORT: String(PORT2), ALLOWED_ORIGINS: "http://allowed.example" },
    stdio: "ignore"
  });
  for (let i = 0; i < 40; i++) {
    try { await (await fetch(`http://localhost:${PORT2}/health`)).json(); break; } catch (e) { await sleep(100); }
  }
  const evil = io(`http://localhost:${PORT2}`, {
    transports: ["polling"], reconnection: false,
    extraHeaders: { origin: "http://evil.example" }
  });
  await once(evil, "connect_error");
  const good = io(`http://localhost:${PORT2}`, {
    transports: ["polling"], reconnection: false,
    extraHeaders: { origin: "http://allowed.example" }
  });
  await once(good, "connect");
  // 같은 origin(서버가 직접 서빙한 페이지)은 목록에 없어도 항상 허용돼야 함
  const sameOrigin = io(`http://localhost:${PORT2}`, {
    transports: ["polling"], reconnection: false,
    extraHeaders: { origin: `http://localhost:${PORT2}` }
  });
  await once(sameOrigin, "connect");
  cors.kill();
  log("17. CORS 화이트리스트 OK — 차단·허용 목록·same-origin 예외 모두 정상");

  /* ========== B2: 공개 방 목록 + 빠른 대전 ========== */
  // 공개 방은 목록에 뜨고, 비공개 방은 안 뜸
  const pubHost = io(URL);
  const privHost = io(URL);
  const hp = await ack(pubHost, "host", { public: true });
  const hv = await ack(privHost, "host", { public: false });
  assert(hp.ok && hv.ok, "공개/비공개 방 생성 실패");
  let rl = await (await fetch(URL + "/rooms")).json();
  assert(rl.rooms.length === 1 && rl.rooms[0].code === hp.code, "공개 방만 목록에 떠야 함");
  // 목록의 코드로 실제 입장 가능
  const lister = io(URL);
  const jl = await ack(lister, "join", rl.rooms[0].code);
  assert(jl.ok, "목록의 방에 입장 가능해야 함");
  rl = await (await fetch(URL + "/rooms")).json();
  assert(rl.rooms.length === 0, "차기 시작한 방은 목록에서 빠져야 함");
  pubHost.emit("leave"); privHost.emit("leave"); lister.emit("leave");
  log("18. 공개 방 목록 OK — 공개만 노출, 목록 입장, 시작 후 제외");

  // 빠른 대전: 첫 번째는 대기, 두 번째에서 매칭 — 역할 배정 + 릴레이 동작
  const q1 = io(URL);
  const q2 = io(URL);
  const m1 = once(q1, "matched");
  const m2 = once(q2, "matched");
  const w1 = await ack(q1, "quick");
  assert(w1.ok && w1.waiting === true, "첫 대기자는 waiting이어야 함");
  const w2 = await ack(q2, "quick");
  assert(w2.ok && w2.waiting === false, "둘째는 즉시 매칭돼야 함");
  const [md1, md2] = await Promise.all([m1, m2]);
  assert(md1.isHost === true && md2.isHost === false, "먼저 기다린 쪽이 호스트여야 함");
  assert(md1.code === md2.code && md1.token && md2.token, "같은 방 + 토큰 발급");
  const qStart = once(q2, "msg");
  q1.emit("msg", { t: "start", target: 20 });
  assert((await qStart).t === "start", "매칭된 방에서 릴레이돼야 함");
  q1.emit("leave"); q2.emit("leave");
  log("19. 빠른 대전 OK — 대기→매칭→역할 배정→릴레이");

  // 대기 취소: 취소한 사람과는 매칭되지 않음
  const q3 = io(URL);
  const q4 = io(URL);
  await ack(q3, "quick");
  q3.emit("quick-cancel");
  await sleep(100);
  const w4 = await ack(q4, "quick");
  assert(w4.waiting === true, "취소자와 매칭되면 안 됨 (q4는 대기여야 함)");
  q4.emit("quick-cancel");
  log("20. 빠른 대전 취소 OK — 취소자는 대기열에서 제외");

  /* ========== B4: 공유 물리 단위 검증 ========== */
  // 조준 샷: 흰 수구(-2.6, 0.5)에서 빨간 공(0,0)을 겨냥 → hits에 2가 있어야 함
  {
    const balls = Phys.initialBalls();
    const angle = Math.atan2(0 - 0.5, 0 - (-2.6));
    const r = Phys.simulateShot(balls, 0, { angle, force: 400, spinX: 0, spinY: 0 });
    assert(r.hits.has(2), "조준한 빨간 공을 맞춰야 함 (hits=" + [...r.hits] + ")");
    assert(r.steps > 0 && r.steps < 120 * 60, "시뮬레이션이 정상 종료돼야 함");
    // 결정론: 같은 샷을 다시 굴리면 좌표가 완전히 일치
    const balls2 = Phys.initialBalls();
    Phys.simulateShot(balls2, 0, { angle, force: 400, spinX: 0, spinY: 0 });
    balls.forEach((b, i) => assert(b.x === balls2[i].x && b.y === balls2[i].y, "결정론 위반: 공 " + i));
    // 규칙: 빨간 공 1개만 → 0점 턴 넘김 / 상대 수구 → -5
    const j1 = Rules.judgeShot(new Set([2]), 0, [0, 0], 0, 30);
    assert(j1.delta === 0 && j1.nextPlayer === 1, "빨간 1개는 0점 + 턴 넘김");
    const j2 = Rules.judgeShot(new Set([1, 2, 3]), 0, [3, 0], 0, 30);
    assert(j2.delta === -5 && j2.scores[0] === 0, "상대 수구 파울 -5 (0점 밑으로는 안 내려감)");
    const j3 = Rules.judgeShot(new Set([2, 3]), 0, [25, 0], 0, 30);
    assert(j3.delta === 10 && j3.over === true, "빨간 2개 +10, 목표 도달 시 승리");
  }
  log("21. 공유 물리·규칙 OK — 조준 명중, 결정론(재실행 좌표 완전 일치), 4구 판정");

  /* ========== B3: 전적 기록 + 랭킹 ========== */
  // 정상 종료: 승자/패자 전적 기록
  const nHost = io(URL);
  const nGuest = io(URL);
  nHost.emit("identify", { uid: "uid-test-winner-01", nick: "당구왕" });
  nGuest.emit("identify", { uid: "uid-test-loser-01", nick: "도전자" });
  await sleep(150);
  const nh = await ack(nHost, "host");
  await ack(nGuest, "join", nh.code);
  nHost.emit("msg", { t: "start", target: 30 });
  await sleep(100);
  nHost.emit("msg", { t: "shot", turn: 1, p: { angle: 0.2, force: 400, spinX: 0, spinY: 0, frac: 0.5 } });
  await sleep(200);
  nHost.emit("msg", { t: "state", turn: 1, s: [30, 0], cp: 0, over: true }); // 호스트 승리 보고
  await sleep(200);
  let rank = await (await fetch(URL + "/ranking")).json();
  assert(rank.top.length >= 1 && rank.top[0].nick === "당구왕" && rank.top[0].wins === 1, "승자가 랭킹 1위여야 함");
  let me = await (await fetch(URL + "/player?uid=uid-test-loser-01")).json();
  assert(me.ok && me.player.losses === 1 && me.player.wins === 0, "패자 전적이 기록돼야 함");
  nHost.emit("leave"); nGuest.emit("leave");
  log("22. 전적 기록 OK — 승/패 반영, 랭킹·내 전적 API");

  // 몰수승도 전적에 기록
  const fHost = io(URL);
  const fGuest = io(URL);
  fHost.emit("identify", { uid: "uid-test-forfeiter", nick: "탈주닌자" });
  fGuest.emit("identify", { uid: "uid-test-survivor", nick: "생존자" });
  await sleep(150);
  const fh = await ack(fHost, "host");
  await ack(fGuest, "join", fh.code);
  fHost.emit("msg", { t: "start", target: 30 });
  await sleep(100);
  const fWin = once(fGuest, "forfeit-win");
  fHost.disconnect(); // 호스트 탈주 → 유예 2초 → 게스트 몰수승
  await fWin;
  await sleep(200);
  me = await (await fetch(URL + "/player?uid=uid-test-survivor")).json();
  assert(me.ok && me.player.wins === 1, "몰수승이 승리로 기록돼야 함");
  assert(me.player.recent[0].forfeit === 1, "몰수 표시가 남아야 함");
  fGuest.emit("leave");
  log("23. 몰수승 전적 기록 OK");

  /* ========== F1: 프리롬 move 메시지 ========== */
  const rHost = io(URL);
  const rGuest = io(URL);
  const rh = await ack(rHost, "host");
  await ack(rGuest, "join", rh.code);
  rHost.emit("msg", { t: "start", target: 30 }); // cp=0 → 호스트 턴, 게스트가 대기 측
  await sleep(100);
  // 대기 측(게스트)의 move는 릴레이됨
  const gotMove = once(rHost, "msg");
  rGuest.emit("msg", { t: "move", x: 8.5, z: -5.2, yaw: 1.1, m: true });
  const mv = (await gotMove);
  assert(mv.t === "move" && mv.x === 8.5, "대기 측 move가 릴레이돼야 함");
  // 차례인 쪽(호스트)의 move는 차단
  await expectDrop(() => rHost.emit("msg", { t: "move", x: 1, z: -6, yaw: 0, m: true }), rGuest, "차례인 쪽의 move");
  // 범위 밖 좌표 차단
  await expectDrop(() => rGuest.emit("msg", { t: "move", x: 50, z: 0, yaw: 0, m: true }), rHost, "범위 밖 move");
  rHost.emit("leave"); rGuest.emit("leave");
  log("24. 프리롬 move OK — 대기 측만 릴레이, 턴 위반·범위 밖 차단");

  /* ========== B4: 서버 심판 가동 확인 ========== */
  hs = await health();
  assert(hs.judge && hs.judge.mode === "flag", "판정 모드는 기본 flag여야 함");
  assert(hs.judge.shots >= 1, "서버가 샷을 시뮬레이션했어야 함 (shots=" + (hs.judge && hs.judge.shots) + ")");
  log("25. 서버 심판 OK — flag 모드에서 샷 " + hs.judge.shots + "건 재시뮬레이션 (불일치 좌표 "
    + hs.judge.coordMiss + "건·점수 " + hs.judge.scoreMiss + "건 기록)");

  console.log("ALL PASS");
  serverProc.kill();
  process.exit(0);
})().catch((e) => fail(e.stack || e.message));
