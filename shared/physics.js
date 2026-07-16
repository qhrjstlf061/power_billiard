"use strict";

/* =========================================================
   공유 물리 (B4) — client/js/game.js의 물리를 THREE/DOM 없이
   그대로 옮긴 것. ⚠️ 결정론 유지를 위해 계산식·연산 순서를
   클라이언트와 반드시 동일하게 유지할 것 (수정 시 양쪽 동시에!)
   원본: Engine.collide1D / resolve2DBallCollision /
         Game.handleWall / Game.physics / Game.fireShot
   ========================================================= */

const BALL_R = 0.18;
const CONST = {
  contactTime: 0.02,
  frictionK: 0.28,
  frictionC: 0.35,
  bounds: { left: -5.2, right: 5.2, top: -2.6, bottom: 2.6 },
  PSTEP: 1 / 120,
  STOP: 0.025
};

// 초기 배치 — Game.layoutBalls와 동일
function initialBalls() {
  const headX = -2.6;
  return [
    { x: headX, y: 0.5, vx: 0, vy: 0, spinV: 0, spinH: 0, mass: 1, radius: BALL_R }, // [0] 흰 수구
    { x: headX, y: 0,   vx: 0, vy: 0, spinV: 0, spinH: 0, mass: 1, radius: BALL_R }, // [1] 노란 공
    { x: 0,     y: 0,   vx: 0, vy: 0, spinV: 0, spinH: 0, mass: 1, radius: BALL_R }, // [2] 빨간 공
    { x: 2.6,   y: 0,   vx: 0, vy: 0, spinV: 0, spinH: 0, mass: 1, radius: BALL_R }  // [3] 빨간 공
  ];
}

function collide1D(m1, v1, m2, v2, e = 1) {
  const v1p = ((m1 - e * m2) * v1 + (1 + e) * m2 * v2) / (m1 + m2);
  const v2p = ((m2 - e * m1) * v2 + (1 + e) * m1 * v1) / (m1 + m2);
  return [v1p, v2p];
}

function resolve2DBallCollision(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const minDist = a.radius + b.radius;
  if (dist === 0 || dist >= minDist) return false;

  const nx = dx / dist, ny = dy / dist;
  const tx = -ny, ty = nx;

  const v1n = a.vx * nx + a.vy * ny;
  const v1t = a.vx * tx + a.vy * ty;
  const v2n = b.vx * nx + b.vy * ny;
  const v2t = b.vx * tx + b.vy * ty;

  if (v1n <= v2n) return false;

  const [nv1n, nv2n] = collide1D(a.mass, v1n, b.mass, v2n, 0.96);
  a.vx = nv1n * nx + v1t * tx;
  a.vy = nv1n * ny + v1t * ty;
  b.vx = nv2n * nx + v2t * tx;
  b.vy = nv2n * ny + v2t * ty;

  const overlap = minDist - dist;
  a.x -= nx * overlap / 2;
  a.y -= ny * overlap / 2;
  b.x += nx * overlap / 2;
  b.y += ny * overlap / 2;
  return v1n - v2n;
}

function handleWall(b) {
  const { left, right, top, bottom } = CONST.bounds;
  const REST = 0.82, TAN = 0.95;
  let nx = 0, nz = 0;
  if (b.x - b.radius < left) { b.x = left + b.radius; b.vx = Math.abs(b.vx) * REST; b.vy *= TAN; nx = 1; }
  if (b.x + b.radius > right) { b.x = right - b.radius; b.vx = -Math.abs(b.vx) * REST; b.vy *= TAN; nx = -1; }
  if (b.y - b.radius < top) { b.y = top + b.radius; b.vy = Math.abs(b.vy) * REST; b.vx *= TAN; nz = 1; }
  if (b.y + b.radius > bottom) { b.y = bottom - b.radius; b.vy = -Math.abs(b.vy) * REST; b.vx *= TAN; nz = -1; }

  if (nx !== 0 || nz !== 0) {
    if (b.spinH) {
      const sp = Math.hypot(b.vx, b.vy);
      const kick = b.spinH * sp * 0.45;
      b.vx += kick * nz;
      b.vy += -kick * nx;
      b.spinH *= 0.5;
    }
  }
}

// Game.physics(dt)와 동일 — hits: 수구가 직접 맞힌 공 기록용 Set (없으면 기록 생략)
function physicsStep(balls, dt, cueIndex, hits) {
  let vmax = 0;
  balls.forEach(b => { vmax = Math.max(vmax, Math.hypot(b.vx, b.vy)); });
  const steps = Math.min(8, Math.max(1, Math.ceil((vmax * dt) / (BALL_R * 0.5))));
  const h = dt / steps;

  for (let s = 0; s < steps; s++) {
    balls.forEach(b => {
      b.x += b.vx * h;
      b.y += b.vy * h;

      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 0) {
        const newSp = Math.max(0, sp - (CONST.frictionK * sp + CONST.frictionC) * h);
        const k = newSp / sp;
        b.vx *= k;
        b.vy *= k;
      }
      if (b.spinV) b.spinV *= Math.max(0, 1 - 0.5 * h);
      if (b.spinH) b.spinH *= Math.max(0, 1 - 0.3 * h);
      handleWall(b);
    });

    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < balls.length; i++) {
        for (let j = i + 1; j < balls.length; j++) {
          const cueBall = (i === cueIndex || j === cueIndex) ? balls[cueIndex] : null;
          let preVx = 0, preVy = 0, preSp = 0;
          if (cueBall && cueBall.spinV) {
            preVx = cueBall.vx;
            preVy = cueBall.vy;
            preSp = Math.hypot(preVx, preVy);
          }

          const impact = resolve2DBallCollision(balls[i], balls[j]);
          if (impact) {
            if (hits) {
              if (i === cueIndex) hits.add(j);
              else if (j === cueIndex) hits.add(i);
            }
            if (cueBall && preSp > 0.05) {
              const boost = cueBall.spinV * preSp * 0.55;
              cueBall.vx += (preVx / preSp) * boost;
              cueBall.vy += (preVy / preSp) * boost;
              cueBall.spinV *= 0.25;
            }
          }
        }
      }
    }
  }
}

function allStopped(balls) {
  return balls.every(b => Math.hypot(b.vx, b.vy) < CONST.STOP);
}

// 샷 하나를 끝까지 시뮬레이션 — Game.fireShot(타격) + update의 120Hz 루프와 동일
function simulateShot(balls, cueIndex, p) {
  const speed = p.force * CONST.contactTime;
  const cue = balls[cueIndex];
  cue.vx = speed * Math.cos(p.angle);
  cue.vy = speed * Math.sin(p.angle);
  cue.spinV = p.spinY;
  cue.spinH = p.spinX;

  const hits = new Set();
  let steps = 0;
  const MAX_STEPS = 120 * 60; // 안전장치: 60초 분량
  while (!allStopped(balls) && steps < MAX_STEPS) {
    physicsStep(balls, CONST.PSTEP, cueIndex, hits);
    steps++;
  }
  balls.forEach(b => { b.vx = 0; b.vy = 0; });
  return { hits, steps };
}

module.exports = { BALL_R, CONST, initialBalls, simulateShot, physicsStep, allStopped };
