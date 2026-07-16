"use strict";

/* =========================================================
   B4: 서버 권위 판정 — 클라와 같은 물리(shared/)로 샷을 재시뮬레이션.
   모드 (환경변수 JUDGE):
   - "off":     시뮬레이션 안 함
   - "flag":    (기본) 호스트 보고와 대조해 불일치를 기록만 — 파급 없음
   - "enforce": 불일치 시 서버 결과로 양쪽을 강제 보정 (치트 차단)
   flag 모드로 실전 데이터에서 물리 포트 정확도를 검증한 뒤 enforce로 올린다.
   ========================================================= */
const Phys = require("../shared/physics");
const Rules = require("../shared/rules");

const MODE = process.env.JUDGE || "flag";
const COORD_TOL = 1e-3; // 부동소수점 결정론이 성립하면 오차는 0에 수렴

const stats = { shots: 0, coordMiss: 0, scoreMiss: 0, corrections: 0 };

function onGameStart(room) {
  if (MODE === "off") return;
  room.judge = { balls: Phys.initialBalls(), expect: null };
}

// 샷 수신 → 서버가 직접 굴려본 결과를 기억해 둠
function onShot(room, msg) {
  if (MODE === "off" || !room.judge) return;
  const st = room.state;
  const cueIndex = st.currentPlayer; // 온라인: 플레이어 i의 수구 = 공 i
  const res = Phys.simulateShot(room.judge.balls, cueIndex, msg.p);
  const verdict = Rules.judgeShot(res.hits, cueIndex, st.scores, st.currentPlayer, st.targetScore);
  stats.shots++;
  room.judge.expect = {
    turn: msg.turn,
    balls: room.judge.balls.map(b => [b.x, b.y]),
    scores: verdict.scores,
    nextPlayer: verdict.over ? st.currentPlayer : verdict.nextPlayer,
    over: verdict.over
  };
}

// 호스트의 샷 종료 좌표 보고와 대조
function onSync(room, msg, io) {
  const j = room.judge;
  if (MODE === "off" || !j || !j.expect || j.expect.turn !== msg.turn) return;
  const bad = msg.b.some((p, i) =>
    Math.abs(p[0] - j.expect.balls[i][0]) > COORD_TOL ||
    Math.abs(p[1] - j.expect.balls[i][1]) > COORD_TOL);
  if (!bad) return;
  stats.coordMiss++;
  console.warn(`[판정] ${room.code.slice(0, 2)}**** 턴 ${msg.turn} 좌표 불일치 (누적 ${stats.coordMiss})`);
  if (MODE === "enforce") correct(room, io);
}

// 호스트의 점수·차례 보고와 대조
function onState(room, msg, io) {
  const j = room.judge;
  if (MODE === "off" || !j || !j.expect || j.expect.turn !== msg.turn) return;
  const e = j.expect;
  const bad = msg.s[0] !== e.scores[0] || msg.s[1] !== e.scores[1]
    || (!e.over && msg.cp !== e.nextPlayer) || !!msg.over !== e.over;
  if (!bad) return;
  stats.scoreMiss++;
  console.warn(`[판정] ${room.code.slice(0, 2)}**** 턴 ${msg.turn} 점수/차례 불일치 (누적 ${stats.scoreMiss})`);
  if (MODE === "enforce") correct(room, io);
}

// enforce: 서버 시뮬레이션 결과를 정답으로 양쪽에 배포 + 세션 상태 덮어씀
function correct(room, io) {
  const e = room.judge.expect;
  const st = room.state;
  st.scores = e.scores.slice();
  st.currentPlayer = e.over ? st.currentPlayer : e.nextPlayer;
  st.turnNo = e.turn;
  st.lastSync = e.balls.map(p => p.slice());
  stats.corrections++;
  io.to(room.code).emit("msg", {
    t: "correct",
    snap: {
      targetScore: st.targetScore,
      scores: st.scores,
      currentPlayer: st.currentPlayer,
      turnNo: st.turnNo,
      balls: st.lastSync
    }
  });
}

module.exports = { MODE, stats, onGameStart, onShot, onSync, onState };
