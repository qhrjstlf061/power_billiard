"use strict";

/* =========================================================
   공유 규칙 (B4) — client/js/game.js의 evaluateShot과 동일한
   4구 판정: 상대 수구 파울 −5 / 빨간 공 2개 +10 / 그 외 0
   득점하면 턴 유지, 실패·파울이면 상대에게
   ========================================================= */
function judgeShot(hits, cueIndex, scores, currentPlayer, targetScore) {
  const oppIdx = cueIndex === 0 ? 1 : 0;
  const hitOpp = hits.has(oppIdx);
  const redCount = (hits.has(2) ? 1 : 0) + (hits.has(3) ? 1 : 0);

  let delta = 0;
  if (hitOpp) delta = -5;
  else if (redCount === 2) delta = 10;

  const s = scores.slice();
  s[currentPlayer] = Math.max(0, s[currentPlayer] + delta);

  const over = targetScore != null && s[currentPlayer] >= targetScore;
  const next = (!over && delta <= 0) ? 1 - currentPlayer : currentPlayer;
  return { delta, scores: s, over, nextPlayer: next };
}

module.exports = { judgeShot };
