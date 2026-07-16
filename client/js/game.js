"use strict";
/* =========================================================
   물리 유틸 — index.html(운동량 시뮬레이션)에서 이식
   ========================================================= */
const Engine = {
  // 반발계수 e를 포함한 일반화 1D 충돌 공식 (e=1: 완전탄성)
  collide1D(m1, v1, m2, v2, e = 1) {
    const v1p = ((m1 - e * m2) * v1 + (1 + e) * m2 * v2) / (m1 + m2);
    const v2p = ((m2 - e * m1) * v2 + (1 + e) * m1 * v1) / (m1 + m2);
    return [v1p, v2p];
  }
};

// 2D 원-원 탄성충돌: 법선 성분에만 collide1D를 적용, 접선 성분은 유지.
// 충돌 시 접근 속도(충격 세기, 소리 볼륨용)를, 충돌이 아니면 false를 반환
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

  if (v1n <= v2n) return false; // 서로 멀어지는 중이면 충돌 처리하지 않음

  // 실제 당구공(페놀 수지)의 반발계수 ≈ 0.96: 미세한 에너지 손실
  const [nv1n, nv2n] = Engine.collide1D(a.mass, v1n, b.mass, v2n, 0.96);
  a.vx = nv1n * nx + v1t * tx;
  a.vy = nv1n * ny + v1t * ty;
  b.vx = nv2n * nx + v2t * tx;
  b.vy = nv2n * ny + v2t * ty;

  const overlap = minDist - dist;
  a.x -= nx * overlap / 2;
  a.y -= ny * overlap / 2;
  b.x += nx * overlap / 2;
  b.y += ny * overlap / 2;
  return v1n - v2n; // 접근 속도(> 0) = 충격 세기
}

/* =========================================================
   절차적 텍스처 — index.html에서 이식/변형
   ========================================================= */
// 4구 캐롬볼: 단색 몸통 + 작은 점 2개(굴러가는 게 보이도록, 실제 공의 마크처럼)
function makeCaromBallTexture(colorHex, dotHex) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#" + colorHex.toString(16).padStart(6, "0");
  ctx.fillRect(0, 0, 256, 128);

  ctx.fillStyle = "#" + dotHex.toString(16).padStart(6, "0");
  [64, 192].forEach(cx => {
    ctx.beginPath();
    ctx.arc(cx, 64, 9, 0, Math.PI * 2);
    ctx.fill();
  });
  return new THREE.CanvasTexture(canvas);
}

/* =========================================================
   카툰 렌더링 유틸 — 툰 셰이딩 그라디언트 + 외곽선(인버티드 헐)
   ========================================================= */
// 4단계 명암 계단: MeshToonMaterial의 gradientMap (NearestFilter 필수)
function makeToonGradient() {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ["#777777", "#aaaaaa", "#d5d5d5", "#ffffff"].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(i, 0, 1, 1);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}
let TOON_GRADIENT = null; // init3D에서 생성

function toonMat(opts) {
  return new THREE.MeshToonMaterial(Object.assign({ gradientMap: TOON_GRADIENT }, opts));
}

const OUTLINE_COLOR = 0x14142a;

// 외곽선: 같은 지오메트리를 BackSide로 뒤집어 살짝 키운 검정 셸을 자식으로 붙임
function addOutline(mesh, scale = 1.05) {
  const outline = new THREE.Mesh(
    mesh.geometry,
    new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide })
  );
  outline.scale.setScalar(scale);
  mesh.add(outline);
  return outline;
}

// 박스류: 면별(6방향) 확장량을 지정하는 외곽선.
// 서로 맞닿는 조각(쿠션-쿠션, 레일-레일)의 접합면은 확장량 0으로 두어
// 이웃 조각 위로 검은 셸이 겹쳐 보이는 현상을 방지한다.
// e = { px, nx, py, ny, pz, nz } (+x, -x, +y, -y, +z, -z 방향 두께)
function addBoxOutline(mesh, w, h, d, e = {}) {
  const ex = Object.assign({ px: 0, nx: 0, py: 0, ny: 0, pz: 0, nz: 0 }, e);
  const outline = new THREE.Mesh(
    mesh.geometry,
    new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide })
  );
  outline.scale.set(
    (w + ex.px + ex.nx) / w,
    (h + ex.py + ex.ny) / h,
    (d + ex.pz + ex.nz) / d
  );
  outline.position.set((ex.px - ex.nx) / 2, (ex.py - ex.ny) / 2, (ex.pz - ex.nz) / 2);
  mesh.add(outline);
  return outline;
}

// 실린더(큐대 부품)용: 반지름 방향으로만 확장 —
// 길이 방향으로 확장하면 이어 붙인 옆 부품 위로 셸이 겹치므로 하지 않는다
function addCylOutline(mesh, r, len, t = 0.014) {
  const outline = new THREE.Mesh(
    mesh.geometry,
    new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide })
  );
  outline.scale.set((r + t) / r, 1, (r + t) / r);
  mesh.add(outline);
  return outline;
}

/* =========================================================
   사운드 엔진 — Web Audio API 절차 생성 (외부 파일 불필요)
   타격/충돌/쿠션음은 노이즈 버스트 + 밴드패스 필터로 합성
   ========================================================= */
const Sound = {
  ctx: null,
  last: {},

  // 브라우저 자동재생 정책: 첫 사용자 입력 때 호출해 활성화
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.85;
      this.master.connect(this.ctx.destination);
      // 화이트노이즈 버퍼를 미리 만들어 재사용
      const len = Math.floor(this.ctx.sampleRate * 0.2);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  },

  playNoise(kind, vol, freq, dur, q) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    if (this.last[kind] && now - this.last[kind] < 0.03) return; // 동시다발 폭주 제한
    this.last[kind] = now;
    vol = Math.min(1, Math.max(0.04, vol));

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(now);
    src.stop(now + dur);
  },

  tones(freqs, { type = "triangle", step = 0.1, vol = 0.22, dur = 0.3 } = {}) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    freqs.forEach((f, i) => {
      const t0 = now + i * step;
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(g);
      g.connect(this.master);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    });
  },

  cueHit(strength) { this.playNoise("cue", 0.25 + strength * 0.5, 1800, 0.08, 2.0); },
  ballHit(strength) { this.playNoise("ball", strength, 3200, 0.07, 2.5); },   // 상아공 "딱" 소리
  cushion(strength) { this.playNoise("cushion", strength * 0.7, 500, 0.1, 1.2); }, // 낮은 "퉁"
  score() { this.tones([659, 988], { step: 0.09 }); },
  foul() { this.tones([233, 175], { type: "sawtooth", vol: 0.14, step: 0.12 }); },
  win() { this.tones([523, 659, 784, 1047], { step: 0.12, dur: 0.35, vol: 0.25 }); }
};

/* =========================================================
   게임 본체 — 4구 캐롬 (포켓 없음)
   공: [0] 흰 수구, [1] 노란 공(상대 수구), [2][3] 빨간 공
   득점: 한 샷에서 빨간 공 2개를 모두 맞히면 +10
   파울: 노란 공을 맞히면 −5
   ========================================================= */
const BALL_R = 0.18; // 캐롬볼(65.5mm)은 포켓볼보다 큼

const Game = {
  // 상태: "MENU"(시작/승리 화면) / "AIM"(조준) / "CHARGE"(힘 충전 중) / "ROLLING"(공 굴러가는 중)
  state: "MENU",
  mode: "solo",         // "solo": 1인 연습 / "versus": 2인 교대 / "online": 온라인 대결
  targetScore: 30,      // 대결 승리 목표 점수
  players: [],
  currentPlayer: 0,
  turnNo: 0,            // 샷 순번 (N2: 네트워크 메시지 검증용)

  // N2: 온라인에서 나의 플레이어 번호 (호스트 = 0/흰 공, 게스트 = 1/노란 공)
  get myIdx() { return Net.isHost ? 0 : 1; },
  isMyTurn() { return this.mode !== "online" || this.currentPlayer === this.myIdx; },
  cueIndex: 0,          // 현재 수구의 공 인덱스 (0=흰 공, 1=노란 공)
  aimAngle: 0,          // 라디안, (x,z) 평면에서 수구 발사 방향
  charging: null,
  cueAnim: null,
  currentShot: null,    // 이번 샷에서 수구가 직접 맞힌 공 인덱스 기록
  spin: { x: 0, y: 0 }, // 당점: x=좌우(사이드), y=상하(밀어/끌어치기), 각 -0.75~0.75
  contactTime: 0.02,    // 큐-공 접촉시간 Δt: v = F·Δt / m
  forceMin: 100,
  forceMax: 800,
  chargeDuration: 1.3,  // 최소힘→최대힘 충전 시간(초)
  frictionK: 0.28,      // 속도 비례 감속(미끄럼 성분 근사) — 빠를수록 마찰 큼
  frictionC: 0.35,      // 굴림 저항(일정 감속) — 실제 당구는 일정 감속이 지배적
  bounds: { left: -5.2, right: 5.2, top: -2.6, bottom: 2.6 },
  balls: [],
  meshes: [],
  flash: [],
  pointer: { x: 0, y: 0 },

  /* ---------- 3D 씬 ---------- */
  init3D() {
    const container = document.getElementById("game-container");

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x12121e);
    TOON_GRADIENT = makeToonGradient();

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // 고DPI 폰에서 과도한 렌더링 방지
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // 좌클릭은 조준/발사 전용 → 카메라 회전은 우클릭, 줌은 휠
    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 22;
    this.controls.enablePan = false;
    this.controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: -1, TWO: THREE.TOUCH.DOLLY_ROTATE };

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.52));
    const dirLight = new THREE.DirectionalLight(0xfff6e6, 0.85);
    dirLight.position.set(4, 10, 5);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.left = -8;
    dirLight.shadow.camera.right = 8;
    dirLight.shadow.camera.top = 8;
    dirLight.shadow.camera.bottom = -8;
    this.scene.add(dirLight);

    this.raycaster = new THREE.Raycaster();

    this.buildTableMesh();
    // H8: 캐릭터 2명 생성 (각자 자기 큐 보유) — P2는 2인 모드에서만 표시
    this.chars = [this.buildCharacter(0x3a6ea5), this.buildCharacter(0xc9a832)];
    this.activeIdx = 0;
    this.chars[1].group.visible = false;
    this.chars[1].cue.visible = false;
    this.buildGuide();
    this.setCameraView("default");
    this.resize();
  },

  buildTableMesh() {
    const { left, right, top, bottom } = this.bounds;
    const tableW = right - left, tableD = bottom - top;
    const cushionH = 0.2, cushionT = 0.14;
    const railH = 0.26, railT = 0.42;

    this.tableGroup = new THREE.Group();

    // 카툰 룩: 플랫 컬러 + 툰 셰이딩 (밝기를 낮춘 딥 톤)
    const felt = new THREE.Mesh(
      new THREE.PlaneGeometry(tableW, tableD),
      toonMat({ color: 0x257040 })
    );
    felt.rotation.x = -Math.PI / 2;
    felt.receiveShadow = true;
    this.tableGroup.add(felt);

    // 안쪽 쿠션 — 캐롬 테이블은 포켓이 없으므로 4면이 끊김 없이 이어짐
    const cushionMat = toonMat({ color: 0x1d5a33 });
    // 외곽선(o)은 노출된 면(테이블 안쪽 + 윗면)으로만 확장 — 접합면은 0
    const ct = 0.05;
    const cushions = [
      { w: tableW + cushionT * 2, d: cushionT, x: 0, z: top - cushionT / 2, o: { pz: ct, py: ct } },
      { w: tableW + cushionT * 2, d: cushionT, x: 0, z: bottom + cushionT / 2, o: { nz: ct, py: ct } },
      { w: cushionT, d: tableD, x: left - cushionT / 2, z: 0, o: { px: ct, py: ct } },
      { w: cushionT, d: tableD, x: right + cushionT / 2, z: 0, o: { nx: ct, py: ct } }
    ];
    cushions.forEach(e => {
      const cushion = new THREE.Mesh(new THREE.BoxGeometry(e.w, cushionH, e.d), cushionMat);
      cushion.position.set(e.x, cushionH / 2, e.z);
      cushion.castShadow = true;
      cushion.receiveShadow = true;
      addBoxOutline(cushion, e.w, cushionH, e.d, e.o);
      this.tableGroup.add(cushion);
    });

    // 바깥 레일: 플랫 브라운
    const railOut = cushionT;
    const railMat = toonMat({ color: 0x64452e });
    // 가로 레일은 코너까지 차지(끝면이 외부로 노출), 세로 레일은 양 끝이 가로 레일과 접합 → z 확장 금지
    const rt = 0.06;
    const rails = [
      { w: tableW + (railOut + railT) * 2, d: railT, x: 0, z: top - railOut - railT / 2, o: { nz: rt, px: rt, nx: rt, py: rt } },
      { w: tableW + (railOut + railT) * 2, d: railT, x: 0, z: bottom + railOut + railT / 2, o: { pz: rt, px: rt, nx: rt, py: rt } },
      { w: railT, d: tableD + railOut * 2, x: left - railOut - railT / 2, z: 0, o: { nx: rt, px: rt, py: rt } },
      { w: railT, d: tableD + railOut * 2, x: right + railOut + railT / 2, z: 0, o: { px: rt, nx: rt, py: rt } }
    ];
    rails.forEach(e => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(e.w, railH, e.d), railMat);
      rail.position.set(e.x, railH / 2, e.z);
      rail.castShadow = true;
      rail.receiveShadow = true;
      addBoxOutline(rail, e.w, railH, e.d, e.o);
      this.tableGroup.add(rail);
    });

    // 다이아몬드 사이트 (장쿠션 5개씩, 단쿠션 3개씩)
    const diamondMat = toonMat({ color: 0xd8d2c0 });
    const diamondGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.012, 12);
    const railCenterOffset = railOut + railT / 2;
    const diamonds = [];
    for (let i = 1; i <= 5; i++) {
      const x = left + (tableW * i) / 6;
      diamonds.push({ x, z: top - railCenterOffset });
      diamonds.push({ x, z: bottom + railCenterOffset });
    }
    for (let i = 1; i <= 3; i++) {
      const z = top + (tableD * i) / 4;
      diamonds.push({ x: left - railCenterOffset, z });
      diamonds.push({ x: right + railCenterOffset, z });
    }
    diamonds.forEach(d => {
      const marker = new THREE.Mesh(diamondGeo.clone(), diamondMat.clone());
      marker.position.set(d.x, railH + 0.006, d.z);
      this.tableGroup.add(marker);
    });

    // H2-1: 바닥 + 테이블 하부 — 실물 크기 캐릭터가 설 무대.
    // 펠트 y=0 기준 실제 테이블 높이 0.8m ≈ 바닥 y=-2.9 (1m ≈ 3.66유닛)
    const FLOOR_Y = -2.9;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), toonMat({ color: 0x232334 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    floor.receiveShadow = true;
    this.tableGroup.add(floor);

    // 테이블 밑판(레일 아래가 비어 보이지 않게) + 다리 4개
    const baseW = tableW + 1.0, baseD = tableD + 1.0, baseH = 0.5;
    const base = new THREE.Mesh(new THREE.BoxGeometry(baseW, baseH, baseD), railMat);
    base.position.y = -baseH / 2;
    addBoxOutline(base, baseW, baseH, baseD, { px: rt, nx: rt, pz: rt, nz: rt });
    this.tableGroup.add(base);

    const legT = 0.55;
    const legH = -FLOOR_Y - baseH;
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz]) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(legT, legH, legT), railMat);
      leg.position.set(sx * (tableW / 2 - 0.7), -baseH - legH / 2, sz * (tableD / 2 - 0.4));
      leg.castShadow = true;
      addBoxOutline(leg, legT, legH, legT, { px: rt, nx: rt, pz: rt, nz: rt });
      this.tableGroup.add(leg);
    });

    this.scene.add(this.tableGroup);
  },

  makeCueStick() {
    // index.html에서 이식: 로컬 +X가 발사 방향, 팁이 로컬 원점. 캐릭터마다 하나씩 생성
    const group = new THREE.Group();
    const tilt = new THREE.Group();
    tilt.rotation.z = -0.16;
    group.add(tilt);

    const addPart = (geometry, material, centerX, r, len) => {
      const part = new THREE.Mesh(geometry, material);
      part.rotation.z = Math.PI / 2;
      part.position.x = centerX;
      part.castShadow = true;
      addCylOutline(part, r, len); // 카툰 외곽선
      tilt.add(part);
      return part;
    };

    addPart(new THREE.CylinderGeometry(0.021, 0.02, 0.022, 12),
      toonMat({ color: 0x40628c }), -0.011, 0.021, 0.022);
    addPart(new THREE.CylinderGeometry(0.021, 0.021, 0.05, 12),
      toonMat({ color: 0xd3ccba }), -0.047, 0.021, 0.05);
    addPart(new THREE.CylinderGeometry(0.031, 0.021, 1.5, 12),
      toonMat({ color: 0xb3986e }), -0.072 - 0.75, 0.031, 1.5);
    addPart(new THREE.CylinderGeometry(0.032, 0.032, 0.022, 12),
      toonMat({ color: 0xd0cabb }), -1.583, 0.032, 0.022);
    addPart(new THREE.CylinderGeometry(0.045, 0.032, 1.1, 12),
      toonMat({ color: 0x5f4433 }), -1.594 - 0.55, 0.045, 1.1);

    group.scale.setScalar(1.9); // 실물 비율(약 1.4m) — 팁이 로컬 원점이라 조준점은 그대로
    this.scene.add(group);
    return group;
  },

  // Phase H2/H6: 실물 크기(신장 약 1.7m) 당구 선수 캐릭터 — 포즈 데이터 기반 리그.
  // 로컬 좌표: 원점 = 바닥, +X = 조준 방향, 큐 라인 = z=0. 좌표는 미터로 정의하고
  // S(3.66)를 곱해 유닛으로 변환. 관절 좌표 테이블(POSES)을 블렌딩해 자세를 만든다.
  POSES: {
    // 엎드린 조준 자세 (H5: 턱-큐 정렬, 몸은 큐 왼쪽, 오른어깨는 큐 라인 위)
    aim: {
      hipC: [-0.1, 0.95, -0.25], waist: [0.15, 1.05, -0.19], chest: [0.42, 1.15, -0.14],
      neckA: [0.52, 1.16, -0.1], neckB: [0.65, 1.15, -0.05], head: [0.75, 1.14, -0.02],
      eyeL: [0.855, 1.13, 0.025], eyeR: [0.855, 1.13, -0.065],
      hipR: [-0.1, 0.95, -0.13], kneeR: [-0.25, 0.5, -0.02], ankleR: [-0.35, 0.08, 0.05], footR: [-0.29, 0.045, 0.05],
      hipL: [-0.1, 0.95, -0.37], kneeL: [0.05, 0.5, -0.42], ankleL: [0.15, 0.08, -0.45], footL: [0.21, 0.045, -0.45],
      shoulderL: [0.5, 1.13, -0.3], elbowL: [0.75, 1.0, -0.22], handL: [0.8, 0.87, -0.05],
      shoulderR: [0.38, 1.16, 0.02]
    },
    // 똑바로 선 기본 자세 (H6): 다리·몸통 수직, 머리 위, 왼팔은 옆에 내리고
    // 오른손은 옆에 세워 둔 큐(로컬 x0.1, z0.3)를 잡는다
    stand: {
      hipC: [0, 0.95, -0.1], waist: [0, 1.12, -0.1], chest: [0, 1.35, -0.1],
      neckA: [0, 1.44, -0.1], neckB: [0, 1.5, -0.1], head: [0, 1.62, -0.1],
      eyeL: [0.105, 1.64, -0.055], eyeR: [0.105, 1.64, -0.145],
      hipR: [0, 0.95, 0.02], kneeR: [0, 0.5, 0.04], ankleR: [0, 0.08, 0.05], footR: [0.06, 0.045, 0.05],
      hipL: [0, 0.95, -0.22], kneeL: [0, 0.5, -0.24], ankleL: [0, 0.08, -0.25], footL: [0.06, 0.045, -0.25],
      shoulderL: [0, 1.38, -0.32], elbowL: [0.02, 1.12, -0.34], handL: [0.04, 0.88, -0.33],
      shoulderR: [0, 1.38, 0.12]
    }
  },
  // H8: 캐릭터 2명 — [0] P1(파란 셔츠, 흰 공), [1] P2(노란 셔츠, 노란 공).
  // 자세 상태(poseBlend/waistAng/gripHandTarget)는 캐릭터 객체별로 보관.
  chars: [],
  activeIdx: 0, // 현재 조준 중인 캐릭터
  get activeC() { return this.chars[this.activeIdx]; },
  get character() { return this.activeC ? this.activeC.group : null; },
  get cueStick() { return this.activeC ? this.activeC.cue : null; },

  buildCharacter(shirtHex) {
    const S = 3.66; // 1m ≈ 3.66유닛 (테이블 10.4유닛 = 실제 대대 2.84m)
    const group = new THREE.Group();
    const skin = toonMat({ color: 0xd9a878 });
    const pants = toonMat({ color: 0x3f3a4a });
    const shoes = toonMat({ color: 0x2a2632 });
    const shirtMat = toonMat({ color: shirtHex }); // 능력자별 색은 Phase K에서 교체
    const V = (x, y, z) => new THREE.Vector3(x * S, y * S, z * S); // 미터 → 유닛

    // 두 점을 잇는 실린더(팔다리·몸통) — r도 미터. len0을 기억해 IK 재배치에 사용
    const limb = (mat, a, b, rM, parent = group) => {
      const r = rM * S;
      const len = a.distanceTo(b);
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
      addCylOutline(mesh, r, len, 0.03);
      mesh.userData.len0 = len;
      mesh.position.copy(a).lerp(b, 0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const orb = (mat, p, rM, outlineScale = 1.09, parent = group) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(rM * S, 16, 12), mat);
      if (outlineScale > 1) addOutline(mesh, outlineScale);
      mesh.position.copy(p);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const shoe = (p) => {
      const w = 0.13 * S, h = 0.09 * S, d = 0.3 * S; // 발은 진행(x)쪽으로 긴 박스
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(d, h, w), shoes);
      addBoxOutline(mesh, d, h, w, { px: 0.03, nx: 0.03, pz: 0.03, nz: 0.03, py: 0.03 });
      mesh.position.copy(p);
      mesh.castShadow = true;
      group.add(mesh);
      return mesh;
    };

    // ---- 리그 구축(H6): 관절 이름으로 메시를 만들고, 실제 자세는 refreshRig가
    //      POSES 블렌딩 결과를 매 프레임 적용한다 ----
    const P = this.POSES.aim; // 초기 생성용 좌표
    const J = (k) => new THREE.Vector3(P[k][0] * S, P[k][1] * S, P[k][2] * S);

    const rig = { limbs: [], orbs: [] };
    const rigLimb = (mat, a, b, rM) => {
      rig.limbs.push({ mesh: limb(mat, J(a), J(b), rM), a, b });
    };
    const rigOrb = (mat, j, rM, outlineScale = 1.09) => {
      rig.orbs.push({ mesh: orb(mat, J(j), rM, outlineScale), j });
    };

    // 다리 + 골반
    rigLimb(pants, "hipR", "kneeR", 0.075);
    rigLimb(pants, "kneeR", "ankleR", 0.065);
    rigLimb(pants, "hipL", "kneeL", 0.075);
    rigLimb(pants, "kneeL", "ankleL", 0.065);
    rigOrb(pants, "kneeR", 0.07);
    rigOrb(pants, "kneeL", 0.07);
    rig.orbs.push({ mesh: shoe(J("footR")), j: "footR" });
    rig.orbs.push({ mesh: shoe(J("footL")), j: "footL" });
    rigOrb(pants, "hipC", 0.16);

    // 몸통(골반→허리→가슴) + 목 + 머리 + 눈
    rigLimb(shirtMat, "hipC", "waist", 0.165);
    rigOrb(shirtMat, "waist", 0.15);
    rigLimb(shirtMat, "waist", "chest", 0.17);
    rigOrb(shirtMat, "chest", 0.17);
    rigLimb(skin, "neckA", "neckB", 0.06);
    rigOrb(skin, "head", 0.115);
    const eyeMat = toonMat({ color: 0x1a1a2e });
    rigOrb(eyeMat, "eyeL", 0.018, 1);
    rigOrb(eyeMat, "eyeR", 0.018, 1);

    // 브리지 팔(왼팔): 어깨-팔꿈치-손
    rigOrb(shirtMat, "shoulderL", 0.065);
    rigLimb(shirtMat, "shoulderL", "elbowL", 0.055);
    rigOrb(skin, "elbowL", 0.055);
    rigLimb(skin, "elbowL", "handL", 0.045);
    rigOrb(skin, "handL", 0.05);

    // 그립 팔(오른팔): 어깨 구슬은 리그 소속, 상완/전완/손은 IK가 구동
    rigOrb(shirtMat, "shoulderR", 0.065);
    const gHand0 = V(0.02, 1.04, 0.05); // 조준 자세에서 큐 손잡이를 잡는 지점
    const gElbowInit = V(0.14, 1.4, 0.05);
    const gripArm = {
      hand0: gHand0,
      L1: 0.36 * S, // 상완 길이
      L2: 0.38 * S, // 전완 길이
      upper: limb(shirtMat, J("shoulderR"), gElbowInit, 0.055),
      forearm: limb(skin, gElbowInit, gHand0, 0.045),
      elbowBall: orb(shirtMat, gElbowInit, 0.055),
      handBall: orb(skin, gHand0, 0.05)
    };

    this.scene.add(group);
    const char = {
      group,
      cue: this.makeCueStick(), // 캐릭터마다 자기 큐를 가짐
      rig,
      gripArm,
      shirtMat,
      poseBlend: 0, // 0 = aim(조준), 1 = stand(기립)
      waistAng: 0,  // 허리 락킹(백스윙) 회전
      gripHandTarget: gHand0.clone()
    };
    this.refreshRig(char); // 초기 자세 적용
    return char;
  },

  // H6: poseBlend(0=조준, 1=기립)와 waistAng(허리 락킹)을 반영해 리그 전체 재배치
  refreshRig(c = this.activeC) {
    if (!c || !c.rig) return;
    const S = 3.66;
    const A = this.POSES.aim, B = this.POSES.stand;
    const t = c.poseBlend;
    const pt = {};
    for (const k in A) {
      pt[k] = new THREE.Vector3(
        (A[k][0] + (B[k][0] - A[k][0]) * t) * S,
        (A[k][1] + (B[k][1] - A[k][1]) * t) * S,
        (A[k][2] + (B[k][2] - A[k][2]) * t) * S
      );
    }
    // 상체 스트레치(H11-2): 테이블 가장자리에 설 때 허리 위를 공 쪽으로 뻗음
    if (c.leanX) {
      pt.waist.x += c.leanX * 0.4;
      ["chest", "neckA", "neckB", "head", "eyeL", "eyeR", "shoulderL", "shoulderR", "elbowL", "handL"]
        .forEach(k => { pt[k].x += c.leanX; });
    }
    // 허리 락킹(H4): 허리 위 관절들을 허리점 기준으로 z축 회전
    if (c.waistAng) {
      const axis = new THREE.Vector3(0, 0, 1);
      ["chest", "neckA", "neckB", "head", "eyeL", "eyeR", "shoulderL", "elbowL", "handL", "shoulderR"]
        .forEach(k => { pt[k].sub(pt.waist).applyAxisAngle(axis, c.waistAng).add(pt.waist); });
    }
    // 시선(H8 아이들): 눈을 머리 중심 기준으로 돌려 목표(수구)를 바라봄
    if (c.eyeYaw) {
      const axisY = new THREE.Vector3(0, 1, 0);
      ["eyeL", "eyeR"].forEach(k => {
        pt[k].sub(pt.head).applyAxisAngle(axisY, c.eyeYaw).add(pt.head);
      });
    }
    // 걷기(H9-2): 기립 포즈 위에 다리 교차 스윙 + 왼팔 스윙 (오른팔은 큐를 듦)
    if (c.walk) {
      const sR = Math.sin(c.walkCycle);
      const sL = Math.sin(c.walkCycle + Math.PI);
      const liftR = Math.max(0, sR) * 0.07 * S;
      const liftL = Math.max(0, sL) * 0.07 * S;
      pt.ankleR.x += sR * 0.22 * S; pt.ankleR.y += liftR;
      pt.footR.x += sR * 0.22 * S;  pt.footR.y += liftR;
      pt.kneeR.x += sR * 0.12 * S;  pt.kneeR.y += liftR * 0.5;
      pt.ankleL.x += sL * 0.22 * S; pt.ankleL.y += liftL;
      pt.footL.x += sL * 0.22 * S;  pt.footL.y += liftL;
      pt.kneeL.x += sL * 0.12 * S;  pt.kneeL.y += liftL * 0.5;
      pt.handL.x += sR * 0.12 * S;  // 왼팔은 오른다리와 같은 위상으로 스윙
      pt.elbowL.x += sR * 0.06 * S;
    }
    // 브리지 팔 IK(H11-3): 조준 중 왼손이 큐 위 브리지 지점을 향함 (닿는 한계까지)
    if (c.bridgeTarget && !c.walk) {
      const r = this.solve2Bone(
        pt.shoulderL, c.bridgeTarget,
        1.07, 0.80, // 조준 포즈 기준 상완·전완 길이(유닛)
        new THREE.Vector3(0.7, -0.25, -0.66) // 팔꿈치는 앞-아래-왼쪽으로 굽힘
      );
      pt.elbowL.copy(r.elbow);
      pt.handL.copy(r.hand);
    }
    c.rig.limbs.forEach(l => this.placeLimb(l.mesh, pt[l.a], pt[l.b]));
    c.rig.orbs.forEach(o => o.mesh.position.copy(pt[o.j]));
    this.solveGripArm(c, c.gripHandTarget, pt.shoulderR);
  },

  // 두 점 사이에 기존 실린더 메시를 재배치 (길이는 len0 대비 스케일)
  placeLimb(mesh, a, b) {
    const len = a.distanceTo(b);
    mesh.position.copy(a).lerp(b, 0.5);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      b.clone().sub(a).normalize()
    );
    mesh.scale.y = len / mesh.userData.len0;
  },

  // 2-본 IK 공통 풀이: 어깨·손 목표·뼈 길이·굽힘 방향(pole) → 팔꿈치/손 위치
  solve2Bone(shoulder, target, L1, L2, pole) {
    const hand = target.clone();
    const toHand = hand.clone().sub(shoulder);
    let d = toHand.length();
    const maxD = L1 + L2 - 0.01;
    if (d > maxD) { // 팔이 닿는 한계 밖이면 손을 한계까지만
      toHand.multiplyScalar(maxD / d);
      d = maxD;
      hand.copy(shoulder).add(toHand);
    }
    const n = toHand.clone().divideScalar(d);
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    let perp = pole.clone().addScaledVector(n, -n.dot(pole));
    if (perp.lengthSq() < 1e-6) perp = new THREE.Vector3(0, 0, 1);
    perp.normalize();
    return { elbow: shoulder.clone().addScaledVector(n, a).addScaledVector(perp, h), hand };
  },

  // H3-2: 그립 팔(오른팔) IK — 팔꿈치 굽힘은 위쪽(+Y)+미세 바깥(z+):
  // 팔꿈치가 들리고 전완이 매달리는 펜듈럼. 등 뒤로 갈 수 없는 구조
  solveGripArm(c, hand, shoulder) {
    if (!c || !c.gripArm) return;
    const g = c.gripArm;
    const r = this.solve2Bone(shoulder, hand, g.L1, g.L2, new THREE.Vector3(0, 1, 0.12));
    this.placeLimb(g.upper, shoulder, r.elbow);
    this.placeLimb(g.forearm, r.elbow, r.hand);
    g.elbowBall.position.copy(r.elbow);
    g.handBall.position.copy(r.hand);
  },

  // H3-3/H4: 스트로크 중 그립 손이 큐 손잡이를 따라감 + 허리 락킹.
  // delta = 큐가 조준 기본 위치에서 뒤로 당겨진 거리(유닛, 팔로스루는 음수)
  updateGripArm(delta) {
    const c = this.activeC;
    if (!c || !c.gripArm) return;
    c.parked = false;
    c.eyeYaw = 0;    // 조준 중에는 큐 라인을 내려다봄
    c.poseBlend = 0; // 조준/스트로크는 항상 엎드린 자세
    c.waistAng = delta * 0.1;
    c.gripHandTarget = c.gripArm.hand0.clone();
    // H11-4: 캐릭터가 테이블 밖으로 밀려난 만큼 큐 손잡이 지점도 앞으로 이동
    c.gripHandTarget.x += (c.aimExtra || 0);
    c.gripHandTarget.x -= delta;

    // H11-3: 브리지 손 목표 = 큐 위 브리지 지점(팁 뒤 0.35m) — 왼팔 IK가 따라감
    c.bridgeTarget = new THREE.Vector3((c.aimDistU || 1.15 * 3.66) - 1.28, 3.18, -0.18);

    // H7: 큐가 들려 있으면(엘리베이션) 손잡이도 그만큼 높아지고,
    // 상체도 함께 일으켜 턱이 올라간 큐를 피한다
    const pitch = this.cuePitch || 0;
    if (pitch > 0.001) {
      const dist = 1.15 * 3.66 - c.gripHandTarget.x; // 팁(공)~손 수평 거리
      c.gripHandTarget.y += dist * (Math.tan(0.16 + pitch) - Math.tan(0.16));
      c.waistAng += pitch * 0.5;
    }

    this.refreshRig(c);
  },

  // H5-6/H6: 샷 후 일어서기 — 엎드린 조준 자세에서 "똑바로 선" 기립 자세로
  // 포즈 블렌딩하고, 큐를 수직으로 세워(팁 위, 밑동 바닥) 오른손에 잡는다.
  updateStandPose(dt) {
    const sa = this.standAnim;
    const c = this.activeC;
    if (!sa || !c) return;
    sa.t = Math.min(sa.dur, sa.t + dt);
    const e = 1 - (1 - sa.t / sa.dur) ** 2; // ease-out

    // 자세: aim → stand 블렌딩, 남아 있던 허리 락킹·상체 스트레치는 0으로
    c.poseBlend = e;
    c.waistAng = sa.fromAng * (1 - e);
    c.leanX = (sa.fromLean || 0) * (1 - e);
    c.bridgeTarget = null;

    // 큐 목표: 캐릭터 오른쪽 옆(로컬 x0.37, z1.1)에 수직으로, 밑동이 바닥에 닿게.
    // 팁이 로컬 원점이므로 팁 높이 = 큐 전체 길이(2.7 × 스케일 1.9)
    this.character.updateMatrixWorld();
    const cueLen = 2.7 * 1.9;
    const cuePosEnd = this.character.localToWorld(new THREE.Vector3(0.37, cueLen, 1.1));
    // 내부 tilt(-0.16)를 상쇄하며 로컬 +X(팁 방향)를 수직 위로
    const quatEnd = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.character.rotation.y)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2 + 0.16));

    this.cueStick.position.lerpVectors(sa.fromCuePos, cuePosEnd, e);
    this.cueStick.quaternion.copy(sa.fromCueQuat).slerp(quatEnd, e);

    // 그립 손: 세워진 큐를 잡음 (기립 자세 어깨 아래, 바닥에서 0.95m)
    if (sa.fromHand) {
      const handEnd = new THREE.Vector3(0.37, 0.95 * 3.66, 1.1);
      c.gripHandTarget = sa.fromHand.clone().lerp(handEnd, e);
    }
    this.refreshRig(c);
  },

  // H8: 차례가 아닌 캐릭터는 테이블 뒤편(기본 카메라에 보이는 쪽)에 서서
  // 큐를 세워 잡고 관전 — 화면 안에 항상 남아 있다
  parkCharacter(c, idx) {
    c.group.position.set(idx === 0 ? -2.2 : 2.2, -2.9, -5.6);
    c.group.rotation.y = -Math.PI / 2; // 로컬 +X(정면)가 테이블(+z) 쪽을 향함
    c.parked = true;                   // 아이들 모션(숨쉬기·시선 추적) 대상
    c.idleT = Math.random() * 10;      // 두 명이 같은 박자로 흔들리지 않게 위상 랜덤
    c.poseBlend = 1; // 기립 자세
    c.waistAng = 0;
    c.leanX = 0;
    c.bridgeTarget = null;
    c.aimExtra = 0;
    c.gripHandTarget = new THREE.Vector3(0.37, 0.95 * 3.66, 1.1);
    this.refreshRig(c);
    this.holdCueVertical(c);
  },

  // 큐를 수직으로 세워(팁 위, 밑동 바닥) 캐릭터 오른손 옆에 들게 함
  holdCueVertical(c) {
    c.group.updateMatrixWorld();
    const cueLen = 2.7 * 1.9;
    c.cue.position.copy(c.group.localToWorld(new THREE.Vector3(0.37, cueLen, 1.1)));
    c.cue.quaternion
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.group.rotation.y)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2 + 0.16));
  },

  // H10: 테이블(레일+여유)을 피해 가는 걷기 경로 계산.
  // 직선이 회피 사각형을 지나면 모서리 4개를 경유지로 한 최단 경로를 찾는다.
  computeWalkPath(from, to) {
    const y = from.y;
    const hx = 6.3, hz = 3.7;             // 회피 사각형 (테이블 외곽 + 몸 여유)
    const bx = hx - 0.05, bz = hz - 0.05; // 차단 판정용(모서리 경유는 통과되도록 살짝 안쪽)

    const inside = (p) => Math.abs(p.x) < bx && Math.abs(p.z) < bz;
    // 세그먼트-사각형 내부 교차 (Liang-Barsky)
    const blocked = (a, b) => {
      const dx = b.x - a.x, dz = b.z - a.z;
      let t0 = 0, t1 = 1;
      const P = [-dx, dx, -dz, dz];
      const Q = [a.x + bx, bx - a.x, a.z + bz, bz - a.z];
      for (let i = 0; i < 4; i++) {
        if (Math.abs(P[i]) < 1e-9) {
          if (Q[i] < 0) return false; // 이 축에서 완전히 바깥 → 교차 없음
        } else {
          const r = Q[i] / P[i];
          if (P[i] < 0) { if (r > t0) t0 = r; }
          else { if (r < t1) t1 = r; }
        }
      }
      return t0 < t1 - 1e-6;
    };
    // 회피 영역 안의 점을 가장 가까운 경계 지점으로 밀어냄
    const exitPoint = (p) => {
      const cand = [
        new THREE.Vector3(hx, y, p.z), new THREE.Vector3(-hx, y, p.z),
        new THREE.Vector3(p.x, y, hz), new THREE.Vector3(p.x, y, -hz)
      ];
      let best = cand[0], bd = Infinity;
      cand.forEach(q => { const d = q.distanceTo(p); if (d < bd) { bd = d; best = q; } });
      return best;
    };

    const start = inside(from) ? exitPoint(from) : from;
    const goal = inside(to) ? exitPoint(to) : to;

    // 모서리 경유 최단 경로 (노드 6개 다익스트라)
    let route = [start, goal];
    if (blocked(start, goal)) {
      const nodes = [
        start,
        new THREE.Vector3(hx, y, hz), new THREE.Vector3(hx, y, -hz),
        new THREE.Vector3(-hx, y, hz), new THREE.Vector3(-hx, y, -hz),
        goal
      ];
      const N = nodes.length;
      const dist = new Array(N).fill(Infinity);
      const prev = new Array(N).fill(-1);
      const done = new Array(N).fill(false);
      dist[0] = 0;
      for (let it = 0; it < N; it++) {
        let u = -1, du = Infinity;
        for (let i = 0; i < N; i++) if (!done[i] && dist[i] < du) { du = dist[i]; u = i; }
        if (u < 0) break;
        done[u] = true;
        for (let v = 0; v < N; v++) {
          if (done[v] || blocked(nodes[u], nodes[v])) continue;
          const nd = dist[u] + nodes[u].distanceTo(nodes[v]);
          if (nd < dist[v]) { dist[v] = nd; prev[v] = u; }
        }
      }
      if (isFinite(dist[N - 1])) {
        route = [];
        let cur = N - 1;
        while (cur !== -1) { route.unshift(nodes[cur]); cur = prev[cur]; }
      }
    }

    // 전체 경로: from → (탈출점) → 경유지들 → (진입점) → to
    const path = [from, ...route, to];
    return path.filter((p, i) => i === 0 || p.distanceTo(path[i - 1]) > 1e-3);
  },

  // H9-1/H10-4: 걷기 시작 — 테이블 회피 경로를 따라 웨이포인트 등속 이동
  startWalk(c, to, endYaw, onArrive) {
    const from = c.group.position.clone();
    const pts = this.computeWalkPath(from, to.clone());

    const segs = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const len = pts[i].distanceTo(pts[i + 1]);
      if (len < 1e-3) continue;
      segs.push({ a: pts[i], b: pts[i + 1], len });
      total += len;
    }
    if (total < 0.05) {
      c.group.rotation.y = endYaw;
      if (onArrive) onArrive();
      return;
    }
    c.walk = { segs, total, traveled: 0, endYaw, onArrive, speed: 1.5 * 3.66 };
    c.walkCycle = 0;
    c.parked = false;
    c.eyeYaw = 0;
    c.poseBlend = 1; // 서서 걸음
    c.waistAng = 0;
    c.leanX = 0;
    c.bridgeTarget = null;
    c.aimExtra = 0;
    c.gripHandTarget = new THREE.Vector3(0.37, 0.95 * 3.66, 1.1); // 세운 큐를 잡은 채
  },

  // H9-1/H9-2: 걷기 진행 — 폴리라인 위 위치·방향·걸음 사이클 갱신, 큐는 세워 든 채
  updateWalkers(dt) {
    this.chars.forEach(c => {
      if (!c.walk) return;
      const w = c.walk;
      w.traveled = Math.min(w.total, w.traveled + w.speed * dt);

      // 현재 구간 찾기
      let d = w.traveled;
      let seg = w.segs[w.segs.length - 1], segT = 1;
      for (const s of w.segs) {
        if (d <= s.len) { seg = s; segT = d / s.len; break; }
        d -= s.len;
      }
      c.group.position.lerpVectors(seg.a, seg.b, segT);

      // 현재 구간의 진행 방향을 보다가, 마지막 15%에서 도착 방향으로 회전
      const walkYaw = Math.atan2(-(seg.b.z - seg.a.z), seg.b.x - seg.a.x);
      const p = w.traveled / w.total;
      let yaw = walkYaw;
      if (p > 0.85) {
        let dy = w.endYaw - walkYaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy)); // 최단 각도
        yaw = walkYaw + dy * ((p - 0.85) / 0.15);
      }
      c.group.rotation.y = yaw;

      c.walkCycle += dt * 6.5; // 걸음 박자
      this.refreshRig(c);
      this.holdCueVertical(c);

      if (p >= 1) {
        const cb = w.onArrive;
        c.walk = null;
        c.walkCycle = 0;
        this.refreshRig(c);
        if (cb) cb();
      }
    });
  },

  /* ---------- F0/F1: 대기 중 자유 이동 (프리롬) ---------- */
  // 순수 연출 — 공·판정·턴에 영향 없음. 상대 턴 동안 내 캐릭터를 WASD로 조작.
  ROAM: {
    speed: 1.5 * 3.66,          // 턴 교대 걷기와 같은 속도
    tableX: 6.3, tableZ: 3.7,   // 테이블 회피 사각형 (computeWalkPath와 동일)
    floorX: 11, floorZ: 8       // 돌아다닐 수 있는 바닥 범위
  },

  canFreeRoam() {
    return this.mode === "online" && this.state !== "MENU" && !this.netPaused
      && !this.isMyTurn() && !!this.chars[this.myIdx] && !this.chars[this.myIdx].walk;
  },

  roamAllowedPos(x, z) {
    const R = this.ROAM;
    if (Math.abs(x) > R.floorX || Math.abs(z) > R.floorZ) return false; // 바닥 밖
    if (Math.abs(x) < R.tableX && Math.abs(z) < R.tableZ) return false; // 테이블 안
    return true;
  },

  updateFreeRoam(dt) {
    if (this.mode !== "online") return;
    const c = this.chars[this.myIdx];
    if (!c) return;

    const can = this.canFreeRoam();
    // 첫 대기 턴 3초 뒤 조작법 힌트 (시작 토스트를 덮지 않게 지연)
    if (can && !this._roamHintShown) {
      this._roamHintT = (this._roamHintT || 0) + dt;
      if (this._roamHintT > 3) {
        this._roamHintShown = true;
        this.showToast("⌨️ 상대 턴 — WASD로 당구장을 돌아다닐 수 있어요!");
      }
    }

    const k = this.keys || {};
    const inF = (k.f ? 1 : 0) - (k.b ? 1 : 0); // 앞/뒤 (카메라 기준)
    const inR = (k.r ? 1 : 0) - (k.l ? 1 : 0); // 오른쪽/왼쪽
    let moving = false;

    if (can && (inF !== 0 || inR !== 0)) {
      // 카메라가 보는 방향을 바닥에 투영해 이동 기준으로 사용
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      let fx = dir.x, fz = dir.z;
      const fl = Math.hypot(fx, fz) || 1;
      fx /= fl; fz /= fl;
      const rx = -fz, rz = fx; // 오른쪽 = forward × up

      let mx = fx * inF + rx * inR;
      let mz = fz * inF + rz * inR;
      const ml = Math.hypot(mx, mz);
      if (ml > 1e-6) {
        mx /= ml; mz /= ml;
        const step = this.ROAM.speed * dt;
        const p = c.group.position;
        // 축 분리 이동 — 경계에 걸리면 미끄러지듯 진행
        const nx = p.x + mx * step;
        if (this.roamAllowedPos(nx, p.z)) p.x = nx;
        const nz = p.z + mz * step;
        if (this.roamAllowedPos(p.x, nz)) p.z = nz;

        // 이동 방향으로 부드럽게 회전 (로컬 +X가 정면)
        const targetYaw = Math.atan2(-mz, mx);
        let dy = targetYaw - c.group.rotation.y;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        c.group.rotation.y += dy * Math.min(1, dt * 10);
        moving = true;
      }
    }

    if (moving) {
      c.roaming = true;
      c.parked = false;
      c.walkCycle += dt * 6.5; // 걷기 모션 재사용
      this.refreshRig(c);
      this.holdCueVertical(c);
    } else if (c.roaming) {
      c.roaming = false;
      if (!c.walk) { // 턴 교대 걷기가 시작됐다면 그쪽에 양보
        c.walkCycle = 0;
        this.refreshRig(c);
        this.holdCueVertical(c);
        c.parked = true; // 대기 모션 복귀
      }
    }

    this.sendRoamMove(dt, c, moving);
  },

  // F1: 내 위치를 10Hz로 상대에게 전송 (움직일 때 + 멈춘 직후 1회)
  sendRoamMove(dt, c, moving) {
    if (!Net.active) return;
    this._roamSendT = (this._roamSendT || 0) + dt;
    if (this._roamSendT < 0.1) return;
    if (!moving && (!this._roamLast || this._roamLast.m === false)) return;
    this._roamSendT = 0;
    this._roamLast = { m: moving };
    const p = c.group.position;
    Net.send({
      t: "move",
      x: Math.round(p.x * 1000) / 1000,
      z: Math.round(p.z * 1000) / 1000,
      yaw: Math.round(c.group.rotation.y * 1000) / 1000,
      m: moving
    });
  },

  // F1 수신: 상대 캐릭터를 목표 좌표로 부드럽게 보간
  updateRemoteRoam(dt) {
    if (this.mode !== "online") return;
    const idx = 1 - this.myIdx;
    const c = this.chars[idx];
    const tgt = this._remoteRoam;
    if (!c || !tgt || c.walk || this.activeIdx === idx) return; // 턴 교대·활성 캐릭터가 우선

    const p = c.group.position;
    const dx = tgt.x - p.x, dz = tgt.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 3) { p.x = tgt.x; p.z = tgt.z; } // 크게 밀리면 스냅
    else if (dist > 0.005) {
      const lerp = Math.min(1, dt * 10);
      p.x += dx * lerp;
      p.z += dz * lerp;
    }
    let dy = tgt.yaw - c.group.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    c.group.rotation.y += dy * Math.min(1, dt * 10);

    const animMoving = tgt.m || dist > 0.15;
    if (animMoving) {
      c.remoteRoaming = true;
      c.parked = false;
      c.walkCycle += dt * 6.5;
      this.refreshRig(c);
      this.holdCueVertical(c);
    } else if (c.remoteRoaming) {
      c.remoteRoaming = false;
      c.walkCycle = 0;
      this.refreshRig(c);
      this.holdCueVertical(c);
      c.parked = true;
    }
  },

  // H8: 턴 교대 — 새 플레이어가 테이블로, 이전 플레이어는 대기 위치로
  setActiveChar(i) {
    if (this.mode === "solo") i = 0;
    this._remoteRoam = null; // F1: 턴이 바뀌면 이전 프리롬 목표는 무효
    if (this.activeIdx === i) return;
    const oldIdx = this.activeIdx;
    const oldC = this.chars[oldIdx];
    this.activeIdx = i;
    const newC = this.chars[i];

    // H9-3: 이전 사람은 대기 위치로 걸어가서 관전 자세로
    this.startWalk(
      oldC,
      new THREE.Vector3(oldIdx === 0 ? -2.2 : 2.2, -2.9, -5.6),
      -Math.PI / 2,
      () => this.parkCharacter(oldC, oldIdx)
    );

    // 새 사람은 수구 뒤 조준 지점으로 걸어온 뒤 엎드려 조준
    // (H11/H12: 허용 각도로 스냅 후, 미세 스트레치 반영된 거리로 목적지 계산)
    this.ensureAimAllowed();
    const cue = this.balls[this.cueIndex];
    const D = Math.min(this.requiredAimDistance(this.aimAngle), (1.15 + 0.2) * 3.66);
    const dest = new THREE.Vector3(
      cue.x - Math.cos(this.aimAngle) * D,
      -2.9,
      cue.y - Math.sin(this.aimAngle) * D
    );
    this.startWalk(newC, dest, -this.aimAngle, null);
  },

  // H8 아이들 모션: 대기 중인 캐릭터가 숨 쉬듯 흔들리고 눈으로 수구를 따라감
  updateIdleChars(dt) {
    this.chars.forEach(c => {
      if (!c.parked || !c.group.visible) return;
      c.idleT += dt;
      // 숨쉬기: 허리가 아주 살짝 앞뒤로 (기립 자세 유지)
      c.waistAng = 0.035 * Math.sin(c.idleT * 1.7);
      // 시선 추적: 수구의 현재 위치를 눈이 따라감 (좌우 ±0.7rad 제한)
      const cue = this.balls[this.cueIndex];
      if (cue) {
        const local = c.group.worldToLocal(new THREE.Vector3(cue.x, 0.18, cue.y));
        c.eyeYaw = Math.max(-0.7, Math.min(0.7, Math.atan2(-local.z, local.x)));
      }
      this.refreshRig(c);
    });
  },

  // Phase K에서 능력자별 셔츠 색을 입힐 때 사용
  setShirtColor(i, hex) {
    if (this.chars[i]) this.chars[i].shirtMat.color.setHex(hex);
  },

  buildGuide() {
    // 조준 가이드: 수구 경로(흰 점선) + 고스트볼 원 + 목적구 예상 방향(하늘색 실선)
    const dashMat = new THREE.LineDashedMaterial({
      color: 0xffffff, dashSize: 0.16, gapSize: 0.11, transparent: true, opacity: 0.75
    });
    this.aimLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), dashMat
    );
    this.aimLine.frustumCulled = false;
    this.scene.add(this.aimLine);

    const circlePts = [];
    for (let i = 0; i <= 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      circlePts.push(new THREE.Vector3(Math.cos(a) * BALL_R, 0, Math.sin(a) * BALL_R));
    }
    this.ghostRing = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(circlePts),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })
    );
    this.ghostRing.frustumCulled = false;
    this.scene.add(this.ghostRing);

    this.targetLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.9 })
    );
    this.targetLine.frustumCulled = false;
    this.scene.add(this.targetLine);
  },

  setGuideVisible(v) {
    this.aimLine.visible = v;
    if (!v) {
      this.ghostRing.visible = false;
      this.targetLine.visible = false;
    }
  },

  setCameraView(mode) {
    if (mode === "top") {
      this.camera.position.set(0, 13, 0.01);
    } else {
      this.camera.position.set(0, 8.5, 7.5);
    }
    this.controls.target.set(0, 0, 0);
    this.camera.lookAt(0, 0, 0);
    this.controls.update();
  },

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  },

  /* ---------- 공 배치 (4구 초구 배치) ---------- */
  layoutBalls() {
    const headX = -2.6; // 헤드 스팟(왼쪽 1/4 지점)
    this.balls = [
      // [0] 흰 수구: 헤드 스팟 옆으로 비켜서
      { x: headX, y: 0.5, vx: 0, vy: 0, spinV: 0, spinH: 0, mass: 1, radius: BALL_R, color: 0xdcd6c6, dot: 0x9e3f39 },
      // [1] 노란 공(상대 수구): 헤드 스팟
      { x: headX, y: 0, vx: 0, vy: 0, spinV: 0, spinH: 0, mass: 1, radius: BALL_R, color: 0xc7a832, dot: 0x9e3f39 },
      // [2] 빨간 공: 테이블 중앙
      { x: 0, y: 0, vx: 0, vy: 0, spinV: 0, spinH: 0, mass: 1, radius: BALL_R, color: 0xa03a34, dot: 0xdcd6c6 },
      // [3] 빨간 공: 풋 스팟(오른쪽 1/4 지점)
      { x: 2.6, y: 0, vx: 0, vy: 0, spinV: 0, spinH: 0, mass: 1, radius: BALL_R, color: 0xa03a34, dot: 0xdcd6c6 }
    ];
    this.flash = new Array(this.balls.length).fill(0);
    this.syncMeshes();
  },

  syncMeshes() {
    this.meshes.forEach(m => {
      this.scene.remove(m);
      m.traverse(c => {
        if (c.isMesh) {
          c.geometry.dispose();
          if (c.material.map) c.material.map.dispose();
          c.material.dispose();
        }
      });
    });

    this.meshes = this.balls.map(b => {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(b.radius, 32, 24),
        toonMat({
          map: makeCaromBallTexture(b.color, b.dot),
          emissive: 0xffaa00,
          emissiveIntensity: 0
        })
      );
      mesh.castShadow = true;
      addOutline(mesh, 1.12); // 카툰 외곽선
      mesh.position.set(b.x, b.radius, b.y);
      mesh.userData.px = b.x;
      mesh.userData.pz = b.y;
      this.scene.add(mesh);
      return mesh;
    });
  },

  startGame(mode) {
    Sound.ensure(); // 시작 버튼 클릭(사용자 제스처)에서 오디오 활성화
    this.mode = mode;
    this.turnNo = 0;
    this._pendingSync = null;
    if (mode === "versus") {
      this.players = [
        { name: "플레이어 1", icon: "⚪", ballIndex: 0, score: 0 },
        { name: "플레이어 2", icon: "🟡", ballIndex: 1, score: 0 }
      ];
    } else if (mode === "online") {
      // 호스트 = 흰 공(선공), 게스트 = 노란 공. 닉네임이 있으면 표시 (B3)
      const me = Net.getNick() || "나";
      const peer = Net.peerNick || "상대";
      this.players = [
        { name: Net.isHost ? me : peer, icon: "⚪", ballIndex: 0, score: 0 },
        { name: Net.isHost ? peer : me, icon: "🟡", ballIndex: 1, score: 0 }
      ];
    } else {
      this.players = [{ name: "연습", icon: "⚪", ballIndex: 0, score: 0 }];
    }
    this.currentPlayer = 0;
    this.cueIndex = 0;
    this.charging = null;
    this.cueAnim = null;
    this.standAnim = null;
    this.currentShot = null;
    this.layoutBalls();
    this.state = "AIM";
    this.aimAngle = 0;
    this.cueStick.visible = true;
    this.updateGauge(0);
    this.setSpin(0, 0); // 새 게임은 무회전 당점부터

    // H8: 캐릭터 배치 — 대결이면 두 명 다 등장, P2는 대기 위치에서 관전
    this.activeIdx = 0;
    const c2 = this.chars[1];
    if (c2) {
      c2.group.visible = c2.cue.visible = (mode !== "solo");
      if (mode !== "solo") this.parkCharacter(c2, 1);
    }

    this.setupScoreboard();
    document.getElementById("overlay-start").classList.remove("show");
    document.getElementById("overlay-win").classList.remove("show");
    if (mode === "versus") this.showToast("⚪ 플레이어 1 차례 — 흰 공으로 치세요");
    if (mode === "online") {
      this.showToast(Net.isHost
        ? "🌐 게임 시작! 당신은 ⚪ 흰 공 — 선공입니다"
        : "🌐 게임 시작! 당신은 🟡 노란 공 — 상대가 먼저 칩니다");
    }
  },

  openMenu() {
    // N4: 온라인 게임 중 메뉴로 나가면 상대에게 알리고 연결 종료
    if (this.mode === "online" && Net.active) {
      Net.send({ t: "bye" });
      Net.cleanup();
      Net.setStatus("연결 종료됨");
      this.mode = "solo";
    }
    this.onNetResume(); // R1: 일시정지 오버레이가 떠 있었다면 정리
    this.state = "MENU";
    this.charging = null;
    this.updateGauge(0);
    document.getElementById("overlay-win").classList.remove("show");
    document.getElementById("overlay-start").classList.add("show");
    document.getElementById("btn-rematch").style.display = ""; // 몰수승에서 숨겼다면 복구
    document.getElementById("btn-online-resume").style.display = Net.loadSession() ? "" : "none";
  },

  setupScoreboard() {
    const duel = this.mode !== "solo";
    document.getElementById("pp0-name").textContent =
      duel ? `${this.players[0].icon} ${this.players[0].name}` : "SCORE";
    if (duel) {
      document.getElementById("pp1-name").textContent =
        `${this.players[1].icon} ${this.players[1].name}`;
    }
    document.getElementById("pp1").style.display = duel ? "" : "none";
    document.getElementById("sb-mid").style.display = duel ? "" : "none";
    document.getElementById("target-label").textContent = this.targetScore;
    this.refreshScores();
    this.highlightTurn();
  },

  refreshScores() {
    this.players.forEach((p, i) => {
      document.getElementById(`pp${i}-score`).textContent = p.score;
    });
  },

  highlightTurn() {
    document.getElementById("pp0").classList.toggle("active", this.currentPlayer === 0);
    document.getElementById("pp1").classList.toggle("active", this.mode !== "solo" && this.currentPlayer === 1);
  },

  /* ---------- 조준(마우스 → 테이블 평면) ---------- */
  pointerToTable(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction;
    if (Math.abs(d.y) < 1e-6) return null;
    const t = (BALL_R - o.y) / d.y; // 공 중심 높이의 수평면과 교차
    if (t < 0) return null;
    return { x: o.x + d.x * t, z: o.z + d.z * t };
  },

  updateAimFromPointer() {
    // N2: 온라인에서 상대 턴이면 내 마우스는 조준에 반영하지 않음 (원격 aim 메시지가 대신)
    if (!this.isMyTurn()) return;
    const p = this.pointerToTable(this.pointer.x, this.pointer.y);
    if (!p) return;
    const cue = this.balls[this.cueIndex];
    const dx = p.x - cue.x, dz = p.z - cue.y;
    if (Math.hypot(dx, dz) < 0.02) return;
    const desired = Math.atan2(dz, dx);

    // H11-2: 캐릭터가 설 수 없는 방향은 조준이 경계에서 막힘 —
    // 현재 각도에서 목표 각도로 조금씩 회전하다가 막히는 지점에서 정지
    this.ensureAimAllowed();
    let diff = desired - this.aimAngle;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // 최단 각도차
    const step = 0.02, dir = Math.sign(diff);
    const steps = Math.floor(Math.abs(diff) / step);
    let cur = this.aimAngle;
    let blockedMid = false;
    for (let i = 0; i < steps; i++) {
      const next = cur + dir * step;
      if (!this.isAimAllowed(next)) { blockedMid = true; break; }
      cur = next;
    }
    if (!blockedMid && this.isAimAllowed(desired)) cur = desired;
    this.aimAngle = cur;
  },

  updateCueAim(offset) {
    // H9: 캐릭터가 조준 지점으로 걸어오는 중에는 걷기 컨트롤러가 몸·큐를 관리
    if (this.activeC && this.activeC.walk) return;
    const cue = this.balls[this.cueIndex];
    const off = offset !== undefined ? offset : cue.radius + 0.05;
    // 당점 반영: 선택한 타점을 겨누도록 큐대를 좌우/상하로 살짝 이동
    const side = this.spin.x * cue.radius * 0.55;
    const lift = this.spin.y * cue.radius * 0.55;
    this.cueStick.position.set(
      cue.x - Math.cos(this.aimAngle) * off - Math.sin(this.aimAngle) * side,
      cue.radius + lift,
      cue.y - Math.sin(this.aimAngle) * off + Math.cos(this.aimAngle) * side
    );
    // H7: 큐 뒤쪽에 쿠션/레일/공이 있으면 실제 당구처럼 큐를 들어올려(엘리베이션)
    // 겹치지 않게 한다. z축 회전 리셋도 겸함(샷 후 수직 자세에서 복귀)
    this.cuePitch = this.computeCuePitch();
    this.cueStick.rotation.set(0, -this.aimAngle, -this.cuePitch);

    // 캐릭터: 수구 뒤 바닥에 서서 조준 방향을 따라 회전.
    // H12: 발이 테이블에 걸리면 최대 0.2m까지만 뒤로 물러서고 그만큼 상체를 살짝 기울임.
    // 그 이상 필요한 각도는 updateAimFromPointer에서 이미 차단됨
    if (this.character) {
      const D0 = 1.15 * 3.66;
      const D = Math.min(this.requiredAimDistance(this.aimAngle), D0 + 0.2 * 3.66);
      const c = this.activeC;
      c.aimDistU = D;
      c.aimExtra = D - D0;
      c.leanX = c.aimExtra * 0.7; // 미세 스트레치 (상체 기울임 최대 ~0.14m)
      this.character.position.set(
        cue.x - Math.cos(this.aimAngle) * D,
        -2.9, // 바닥(H2-1) 위
        cue.y - Math.sin(this.aimAngle) * D
      );
      this.character.rotation.y = -this.aimAngle;
      this.updateGripArm(off - (cue.radius + 0.05));
    }
  },

  // H7: 큐대 충돌 회피 — 조준 방향 뒤쪽 레이에 걸리는 쿠션/레일/공의 윗면을
  // 큐 밑면이 넘도록 필요한 추가 엘리베이션(피치)을 계산한다.
  // (기본 틸트 0.16rad보다 더 들어야 할 때만 양수 반환, 물리는 수평 타격 유지)
  computeCuePitch() {
    const cue = this.balls[this.cueIndex];
    if (!cue) return 0;
    const dirX = -Math.cos(this.aimAngle), dirZ = -Math.sin(this.aimAngle); // 큐가 뻗는 뒤쪽
    const tipY = cue.radius;
    const margin = 0.06, cueR = 0.09; // 여유 간격, 큐 몸통 반지름(두꺼운 쪽 기준)
    const reach = 2.7 * 1.9 + 1.2;    // 큐 길이 + 최대 백스윙

    let slopeNeed = Math.tan(0.16); // 기본 틸트의 기울기
    const consider = (d, topH) => {
      if (d < 0.15 || d > reach) return;
      const slope = (topH + margin + cueR - tipY) / d;
      if (slope > slopeNeed) slopeNeed = slope;
    };

    // 쿠션(높이 0.2)·레일(높이 0.26): 뒤쪽 레이가 쿠션 안쪽면을 지나는 거리에서 검사
    const { left, right, top, bottom } = this.bounds;
    const wallTs = [];
    if (dirX > 1e-6) wallTs.push((right - cue.x) / dirX);
    if (dirX < -1e-6) wallTs.push((left - cue.x) / dirX);
    if (dirZ > 1e-6) wallTs.push((bottom - cue.y) / dirZ);
    if (dirZ < -1e-6) wallTs.push((top - cue.y) / dirZ);
    wallTs.forEach(t => {
      if (t <= 0) return;
      consider(t, 0.2);          // 쿠션 안쪽 위 모서리
      consider(t + 0.14, 0.26);  // 레일 안쪽 위 모서리
    });

    // 다른 공: 뒤쪽 레이에 걸치면(수직 거리 < 공+큐 반지름) 공 꼭대기 위로
    this.balls.forEach((b, i) => {
      if (i === this.cueIndex) return;
      const rx = b.x - cue.x, rz = b.y - cue.y;
      const proj = rx * dirX + rz * dirZ;
      if (proj <= 0 || proj > reach) return;
      const perp = Math.hypot(rx - dirX * proj, rz - dirZ * proj);
      if (perp < b.radius + cueR) consider(proj, b.radius * 2);
    });

    return Math.min(0.55, Math.max(0, Math.atan(slopeNeed) - 0.16));
  },

  // H12-1: 이 각도에서 캐릭터 발이 테이블 밖에 서기 위한 최소 거리(유닛)
  requiredAimDistance(angle) {
    const D0 = 1.15 * 3.66;
    const cue = this.balls[this.cueIndex];
    if (!cue) return D0;
    const dx = -Math.cos(angle), dz = -Math.sin(angle);
    const hx = 6.05, hz = 3.45; // 테이블 외곽 + 몸 여유
    let tExit = Infinity;
    if (Math.abs(dx) > 1e-9) tExit = Math.min(tExit, (dx > 0 ? (hx - cue.x) : (-hx - cue.x)) / dx);
    if (Math.abs(dz) > 1e-9) tExit = Math.min(tExit, (dz > 0 ? (hz - cue.y) : (-hz - cue.y)) / dz);
    if (!isFinite(tExit) || tExit < 0) return D0;
    return Math.max(D0, tExit + 0.12);
  },

  // H11/H12: 기본 거리 + 미세 스트레치(최대 0.2m)로 커버 가능한 각도만 허용
  isAimAllowed(angle) {
    return this.requiredAimDistance(angle) <= (1.15 + 0.2) * 3.66 + 1e-6;
  },

  // H11-3: 현재 각도가 막힌 상태면(샷 후 수구 이동 등) 가장 가까운 허용 각도로 스냅
  ensureAimAllowed() {
    if (this.isAimAllowed(this.aimAngle)) return;
    for (let a = 0.02; a <= Math.PI; a += 0.02) {
      if (this.isAimAllowed(this.aimAngle + a)) { this.aimAngle += a; return; }
      if (this.isAimAllowed(this.aimAngle - a)) { this.aimAngle -= a; return; }
    }
  },

  // 조준선: 진행 경로에서 처음 만나는 공(고스트볼) 또는 쿠션까지
  updateGuide() {
    const cue = this.balls[this.cueIndex];
    const dx = Math.cos(this.aimAngle), dz = Math.sin(this.aimAngle);

    // 1) 공과의 충돌 (고스트볼: 두 공 중심거리 = 2R이 되는 지점)
    let bestT = Infinity, hitBall = null;
    for (let i = 0; i < this.balls.length; i++) {
      if (i === this.cueIndex) continue;
      const b = this.balls[i];
      const rx = b.x - cue.x, rz = b.y - cue.y;
      const proj = rx * dx + rz * dz;
      if (proj <= 0) continue;
      const R = b.radius + cue.radius;
      const perp2 = rx * rx + rz * rz - proj * proj;
      if (perp2 > R * R) continue;
      const t = proj - Math.sqrt(R * R - perp2);
      if (t > 0 && t < bestT) { bestT = t; hitBall = b; }
    }

    // 2) 쿠션과의 충돌
    const { left, right, top, bottom } = this.bounds;
    let tWall = Infinity;
    if (dx > 1e-9) tWall = Math.min(tWall, (right - cue.radius - cue.x) / dx);
    if (dx < -1e-9) tWall = Math.min(tWall, (left + cue.radius - cue.x) / dx);
    if (dz > 1e-9) tWall = Math.min(tWall, (bottom - cue.radius - cue.y) / dz);
    if (dz < -1e-9) tWall = Math.min(tWall, (top + cue.radius - cue.y) / dz);

    const t = Math.min(bestT, tWall);
    if (!isFinite(t) || t <= 0) { this.setGuideVisible(false); return; }

    const hx = cue.x + dx * t, hz = cue.y + dz * t;
    const y = BALL_R;

    // 당점에 따라 조준선 색이 변함: 밀어치기=주황, 끌어치기=파랑, 무회전=흰색
    if (this.spin.y > 0.15) this.aimLine.material.color.setHex(0xffab91);
    else if (this.spin.y < -0.15) this.aimLine.material.color.setHex(0x90caf9);
    else this.aimLine.material.color.setHex(0xffffff);

    this.aimLine.visible = true;
    this.aimLine.geometry.setFromPoints([
      new THREE.Vector3(cue.x + dx * (cue.radius + 0.02), y, cue.y + dz * (cue.radius + 0.02)),
      new THREE.Vector3(hx, y, hz)
    ]);
    this.aimLine.computeLineDistances();

    if (hitBall && bestT <= tWall) {
      this.ghostRing.visible = true;
      this.ghostRing.position.set(hx, y, hz);

      // 목적구 예상 진행 방향: 고스트볼 중심 → 목적구 중심
      const tx = hitBall.x - hx, tz = hitBall.y - hz;
      const tl = Math.hypot(tx, tz) || 1;
      this.targetLine.visible = true;
      this.targetLine.geometry.setFromPoints([
        new THREE.Vector3(hitBall.x, y, hitBall.y),
        new THREE.Vector3(hitBall.x + (tx / tl) * 0.9, y, hitBall.y + (tz / tl) * 0.9)
      ]);
    } else {
      this.ghostRing.visible = false;
      this.targetLine.visible = false;
    }
  },

  /* ---------- 발사 (충전 → 스트로크) ---------- */
  beginCharge() {
    if (this.state !== "AIM") return;
    if (this.netPaused) return;                    // R1: 재접속 대기 중에는 발사 불가
    if (!this.isMyTurn()) return;                  // N2: 상대 턴에는 발사 불가
    if (this.activeC && this.activeC.walk) return; // 걸어오는 동안은 발사 대기
    this.state = "CHARGE";
    this.charging = { t: 0, force: this.forceMin };
  },

  // 충전 중 취소: 발사하지 않고 조준 상태로 복귀 (우클릭 / ESC)
  cancelCharge() {
    if (!this.charging) return;
    this.charging = null;
    this.state = "AIM";
    this.updateGauge(0);
    this.updateCueAim(); // 큐대를 조준 위치로 원상 복귀
    this.showToast("↩️ 샷 취소");
  },

  releaseCharge() {
    if (!this.charging) return;
    const charge = this.charging;
    this.charging = null;
    const frac = Math.min(1, charge.t / this.chargeDuration);
    const params = {
      angle: this.aimAngle,
      force: charge.force,
      spinX: this.spin.x,
      spinY: this.spin.y,
      frac
    };
    this.fireShot(params);
    // N2: 온라인이면 내 샷 파라미터를 상대에게 전송 (양쪽이 같은 물리를 재생)
    if (this.mode === "online") Net.send({ t: "shot", turn: this.turnNo, p: params });
  },

  // N0: 발사 공통 진입점 — 로컬 입력과 네트워크 수신 샷이 같은 경로를 탄다
  fireShot(p) {
    this.aimAngle = p.angle;
    this.setSpin(p.spinX, p.spinY);
    const speed = p.force * this.contactTime;
    const cue = this.balls[this.cueIndex];
    const rest = cue.radius + 0.05;
    const frac = p.frac !== undefined ? p.frac : 1;
    this.turnNo = (this.turnNo || 0) + 1;
    this.physAcc = 0;
    this.cueAnim = {
      t: 0,
      strokeT: 0.1 + 0.06 * frac,   // 세게 칠수록 스트로크가 약간 김
      followT: 0.2,
      pullback: rest + (0.35 + speed * 0.025) * frac,
      speed,
      angle: p.angle,
      fired: false
    };
    this.state = "ROLLING";
    this.setGuideVisible(false);
    this.updateGauge(0);
  },

  updateGauge(frac, force) {
    // 충전 중에만 게이지 표시
    document.getElementById("power-gauge").classList.toggle("active", force !== undefined);
    document.getElementById("power-fill").style.width = (frac * 100) + "%";
    document.getElementById("power-label").textContent = force !== undefined ? `${Math.round(force)} N` : "";
  },

  /* ---------- 4구 판정 & 턴 ---------- */
  evaluateShot() {
    const shot = this.currentShot;
    this.currentShot = null;
    if (!shot) return;

    const player = this.players[this.currentPlayer];
    const oppIdx = this.cueIndex === 0 ? 1 : 0;
    const hitOpp = shot.hits.has(oppIdx);
    const redCount = (shot.hits.has(2) ? 1 : 0) + (shot.hits.has(3) ? 1 : 0);

    let msg, delta = 0;
    if (hitOpp) {
      delta = -5;
      msg = `😱 파울! ${oppIdx === 0 ? "흰" : "노란"} 공(상대 수구)을 맞췄습니다 −5점`;
    } else if (redCount === 2) {
      delta = 10;
      msg = "🎉 득점! 빨간 공 2개를 모두 맞췄습니다 +10점";
    } else if (redCount === 1) {
      msg = "아깝다… 빨간 공 1개만 맞췄습니다";
    } else {
      msg = "빗나감… 빨간 공을 맞추지 못했습니다";
    }

    player.score = Math.max(0, player.score + delta);
    this.refreshScores();
    this.animateScore(this.currentPlayer, delta);

    // 득점/파울 연출: 효과음 + 화면 가장자리 플래시
    if (delta > 0) { Sound.score(); this.fxFlash("gain"); }
    else if (delta < 0) { Sound.foul(); this.fxFlash("foul"); }

    // 승리 판정 (대결: 목표 점수 선취)
    if (this.mode !== "solo" && player.score >= this.targetScore) {
      this.showWin(player);
      return;
    }

    // 한국식 4구 턴 규칙: 득점하면 계속 치고, 실패/파울이면 상대에게
    if (this.mode !== "solo" && delta <= 0) {
      this.currentPlayer = this.currentPlayer === 0 ? 1 : 0;
      const next = this.players[this.currentPlayer];
      this.cueIndex = next.ballIndex;
      this.highlightTurn();
      this.setActiveChar(this.currentPlayer); // 캐릭터 교대 (이전 사람은 대기 위치로)
      msg += ` → ${next.icon} ${next.name} 차례`;
    }

    this.showToast(msg);
  },

  animateScore(playerIdx, delta) {
    if (delta === 0) return;
    const scoreEl = document.getElementById(`pp${playerIdx}-score`);
    const deltaEl = document.getElementById("score-delta");
    const cls = delta > 0 ? "gain" : "foul";

    scoreEl.classList.remove("pop", "gain", "foul");
    deltaEl.classList.remove("fly", "gain", "foul");
    deltaEl.textContent = (delta > 0 ? "+" : "−") + Math.abs(delta);

    // 점수 팝 + 색 플래시, "+10 / −5" 숫자가 위로 날아가는 연출
    requestAnimationFrame(() => {
      scoreEl.classList.add("pop", cls);
      deltaEl.classList.add("fly", cls);
    });
    clearTimeout(this._scoreAnimTimer);
    this._scoreAnimTimer = setTimeout(() => {
      scoreEl.classList.remove("pop", "gain", "foul");
      deltaEl.classList.remove("fly", "gain", "foul");
    }, 1000);
  },

  fxFlash(kind) {
    const el = document.getElementById("fx-flash");
    el.className = kind + " on";
    clearTimeout(this._fxTimer);
    this._fxTimer = setTimeout(() => el.classList.remove("on"), 180);
  },

  showWin(player) {
    this.state = "MENU";
    Sound.win();
    const other = this.players.find(p => p !== player);
    document.getElementById("win-title").textContent = `🏆 ${player.icon} ${player.name} 승리!`;
    document.getElementById("win-desc").textContent =
      `${player.score} : ${other.score} — 목표 ${this.targetScore}점 선취!`;
    document.getElementById("overlay-win").classList.add("show");
  },

  /* ---------- 물리 ---------- */
  handleWall(b) {
    const { left, right, top, bottom } = this.bounds;
    // 현실적인 쿠션 모델: 법선 반발계수(REST)와 접선 마찰(TAN)을 분리 적용
    // → 반사각이 실제처럼 살짝 짧아지고(입사각보다 작아짐) 속도가 죽는다
    const REST = 0.82, TAN = 0.95;
    let nx = 0, nz = 0; // 반사가 일어난 쿠션의 안쪽 법선
    if (b.x - b.radius < left) { b.x = left + b.radius; b.vx = Math.abs(b.vx) * REST; b.vy *= TAN; nx = 1; }
    if (b.x + b.radius > right) { b.x = right - b.radius; b.vx = -Math.abs(b.vx) * REST; b.vy *= TAN; nx = -1; }
    if (b.y - b.radius < top) { b.y = top + b.radius; b.vy = Math.abs(b.vy) * REST; b.vx *= TAN; nz = 1; }
    if (b.y + b.radius > bottom) { b.y = bottom - b.radius; b.vy = -Math.abs(b.vy) * REST; b.vx *= TAN; nz = -1; }

    if (nx !== 0 || nz !== 0) {
      // 사이드 스핀(좌/우 당점): 쿠션 반사 순간 접선 방향 킥 → 반사각이 꺾임.
      // 스핀 방향에 따른 접선은 ω×n 에서 유도: (nz, -nx) 방향
      if (b.spinH) {
        const sp = Math.hypot(b.vx, b.vy);
        const kick = b.spinH * sp * 0.45;
        b.vx += kick * nz;
        b.vy += -kick * nx;
        b.spinH *= 0.5; // 쿠션에 닿을 때마다 스핀 소모
      }
      Sound.cushion(Math.min(1, Math.hypot(b.vx, b.vy) / 9));
    }
  },

  physics(dt) {
    const balls = this.balls;

    // 서브스텝: 빠른 공이 벽/공을 뚫는 터널링 방지
    let vmax = 0;
    balls.forEach(b => { vmax = Math.max(vmax, Math.hypot(b.vx, b.vy)); });
    const steps = Math.min(8, Math.max(1, Math.ceil((vmax * dt) / (BALL_R * 0.5))));
    const h = dt / steps;

    for (let s = 0; s < steps; s++) {
      balls.forEach(b => {
        b.x += b.vx * h;
        b.y += b.vy * h;

        // 마찰: 속도 비례 감속 + 굴림 저항(일정 감속)
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > 0) {
          const newSp = Math.max(0, sp - (this.frictionK * sp + this.frictionC) * h);
          const k = newSp / sp;
          b.vx *= k;
          b.vy *= k;
        }
        // 스핀 감쇠: 천과의 마찰로 회전이 점점 굴림으로 전환됨
        if (b.spinV) b.spinV *= Math.max(0, 1 - 0.5 * h);
        if (b.spinH) b.spinH *= Math.max(0, 1 - 0.3 * h);
        this.handleWall(b);
      });

      // 2패스 스캔: 공이 붙어 있을 때 연쇄 충돌이 한 스텝 안에서 전파되도록
      for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < balls.length; i++) {
        for (let j = i + 1; j < balls.length; j++) {
          // 상/하 당점 처리를 위해 수구의 충돌 직전 속도를 기억해 둠
          const cueBall = (i === this.cueIndex || j === this.cueIndex) ? balls[this.cueIndex] : null;
          let preVx = 0, preVy = 0, preSp = 0;
          if (cueBall && cueBall.spinV) {
            preVx = cueBall.vx;
            preVy = cueBall.vy;
            preSp = Math.hypot(preVx, preVy);
          }

          const impact = resolve2DBallCollision(balls[i], balls[j]);
          if (impact) {
            this.flash[i] = this.flash[j] = 0.5;
            Sound.ballHit(Math.min(1, impact / 9)); // 세게 부딪힐수록 큰 "딱" 소리
            // 현재 수구가 직접 맞힌 공만 판정에 기록
            if (this.currentShot) {
              if (i === this.cueIndex) this.currentShot.hits.add(j);
              else if (j === this.cueIndex) this.currentShot.hits.add(i);
            }
            // 밀어치기/끌어치기: 충돌 직후 수구가 원래 진행 방향으로
            // 따라가거나(상단 당점, +) 뒤로 끌려옴(하단 당점, −)
            if (cueBall && preSp > 0.05) {
              const boost = cueBall.spinV * preSp * 0.55;
              cueBall.vx += (preVx / preSp) * boost;
              cueBall.vy += (preVy / preSp) * boost;
              cueBall.spinV *= 0.25; // 스핀 대부분이 충돌에서 소모됨
            }
          }
        }
      }
      }
    }

    for (let i = 0; i < this.flash.length; i++) {
      this.flash[i] = Math.max(0, this.flash[i] - dt);
    }
  },

  allStopped() {
    return this.balls.every(b => Math.hypot(b.vx, b.vy) < 0.025);
  },

  /* ---------- 메인 업데이트 ---------- */
  update(dt) {
    this.updateWalkers(dt);   // 걷는 캐릭터 이동 (H9)
    this.updateIdleChars(dt); // 대기 캐릭터는 어느 상태에서든 살아 움직임
    this.updateFreeRoam(dt);   // F0: 상대 턴 자유 이동 (내 캐릭터)
    this.updateRemoteRoam(dt); // F1: 상대의 자유 이동 반영

    if (this.state === "MENU") return; // 시작/승리 화면에서는 정지

    if (this.state === "AIM") {
      this.updateAimFromPointer();
      this.updateCueAim();
      this.updateGuide();
      this.sendAimPreview(dt); // N3: 내 조준을 상대 화면에 실시간 표시
      return;
    }

    if (this.state === "CHARGE") {
      this.charging.t += dt;
      const frac = Math.min(1, this.charging.t / this.chargeDuration);
      this.charging.force = this.forceMin + (this.forceMax - this.forceMin) * frac;
      this.updateGauge(frac, this.charging.force);

      const cue = this.balls[this.cueIndex];
      const rest = cue.radius + 0.05;
      const speed = this.charging.force * this.contactTime;
      this.updateCueAim(rest + (0.35 + speed * 0.025) * frac);
      this.updateGuide(); // 각도는 고정, 라인은 유지
      this.sendAimPreview(dt); // N3: 충전 게이지도 상대에게
      return;
    }

    // ROLLING: 큐대 스트로크 → 타격 → 물리
    if (this.cueAnim) {
      const anim = this.cueAnim;
      anim.t += dt;
      const cue = this.balls[this.cueIndex];
      const contact = cue.radius + 0.005;
      let offset;

      if (anim.t < anim.strokeT) {
        const q = anim.t / anim.strokeT;
        offset = anim.pullback + (contact - anim.pullback) * q * q; // ease-in 가속
      } else {
        if (!anim.fired) {
          anim.fired = true;
          anim.strikeX = cue.x;
          anim.strikeZ = cue.y;
          cue.vx = anim.speed * Math.cos(anim.angle);
          cue.vy = anim.speed * Math.sin(anim.angle);
          // 당점 적용: 타격 순간의 스핀이 수구에 실림
          cue.spinV = this.spin.y;
          cue.spinH = this.spin.x;
          Sound.cueHit(Math.min(1, anim.speed / 16));
          this.currentShot = { hits: new Set() }; // 이번 샷 판정 기록 시작
        }
        const q = Math.min(1, (anim.t - anim.strokeT) / anim.followT);
        offset = contact - 0.12 * (1 - (1 - q) * (1 - q)); // 팔로스루
        if (q >= 1) {
          this.cueAnim = null;
          // 팔로스루가 끝나면 일어서서 큐를 수직으로 세워 잡고 공을 지켜본다
          const finalDelta = offset - (cue.radius + 0.05);
          const ac = this.activeC;
          const fromHand = ac && ac.gripArm ? ac.gripArm.hand0.clone() : null;
          if (fromHand) fromHand.x -= finalDelta;
          this.standAnim = {
            t: 0,
            dur: 0.7,
            fromAng: ac ? ac.waistAng : 0,
            fromLean: ac ? (ac.leanX || 0) : 0,
            fromCuePos: this.cueStick.position.clone(),
            fromCueQuat: this.cueStick.quaternion.clone(),
            fromHand
          };
        }
      }

      if (this.cueAnim) {
        if (!anim.fired) {
          this.updateCueAim(offset);
        } else {
          this.cueStick.position.set(
            anim.strikeX - Math.cos(anim.angle) * offset,
            cue.radius,
            anim.strikeZ - Math.sin(anim.angle) * offset
          );
          // 팔로스루: 그립 팔이 큐와 함께 앞으로 뻗어짐 (delta 음수)
          this.updateGripArm(offset - (cue.radius + 0.05));
        }
      }
      if (!anim.fired) return; // 타격 전에는 공 정지
    }

    // 샷 후 일어서기: 상체를 세우고 큐를 수직으로 세워 잡는 전환 애니메이션
    if (this.standAnim) this.updateStandPose(dt);

    // N0: 고정 타임스텝(120Hz) 물리 — 같은 샷 입력이면 어떤 기기·프레임레이트에서도
    // 완전히 같은 결과 (온라인 입력 동기화의 전제). 정지 판정도 스텝 안에서 확정.
    this.physAcc = (this.physAcc || 0) + dt;
    const PSTEP = 1 / 120;
    while (this.physAcc >= PSTEP) {
      this.physics(PSTEP);
      this.physAcc -= PSTEP;
      if (this.allStopped()) {
        this.balls.forEach(b => { b.vx = 0; b.vy = 0; });
        this.physAcc = 0;
        break;
      }
    }

    // 모든 공이 멈추면 판정 후 다음 샷 준비
    if (!this.cueAnim && this.allStopped()) {
      this.balls.forEach(b => { b.vx = 0; b.vy = 0; });
      this.standAnim = null; // 일어서기 종료 → 다음 조준 자세로

      // N4: 샷 종료 좌표 동기화 — 호스트는 전송, 게스트는 대기 중이던 보정 적용
      if (this.mode === "online") {
        if (Net.isHost) {
          Net.send({ t: "sync", turn: this.turnNo, b: this.balls.map(b => [b.x, b.y]) });
        } else if (this._pendingSync) {
          this.applySync(this._pendingSync);
          this._pendingSync = null;
        }
      }

      this.evaluateShot(); // 승리 시 내부에서 state를 MENU로 바꿈

      // R0: 판정 직후 확정 상태(점수·다음 차례)를 호스트가 서버에 알림 —
      // 서버가 세션 상태로 기록 (게스트는 모르는 타입이라 무시)
      if (this.mode === "online" && Net.isHost) {
        Net.send({
          t: "state",
          turn: this.turnNo,
          s: this.players.map(p => p.score),
          cp: this.currentPlayer,
          over: this.state === "MENU"
        });
      }

      if (this.state !== "MENU") {
        this.state = "AIM";
        this.cueStick.visible = true;
        this.updateAimFromPointer();
        this.updateCueAim();
      }
    }
  },

  render() {
    this.balls.forEach((b, i) => {
      const mesh = this.meshes[i];
      const dx = b.x - mesh.userData.px;
      const dz = b.y - mesh.userData.pz;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-5) {
        const axis = new THREE.Vector3(dz, 0, -dx).normalize();
        mesh.rotateOnWorldAxis(axis, dist / b.radius);
      }
      mesh.position.set(b.x, b.radius, b.y);
      mesh.userData.px = b.x;
      mesh.userData.pz = b.y;
      mesh.material.emissiveIntensity = this.flash[i] * 1.5;
    });

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  },

  /* ---------- 온라인 (N2~N4) ---------- */
  // N3: 내 턴에 조준 상태를 10Hz로 상대에게 전송
  sendAimPreview(dt) {
    if (this.mode !== "online" || !this.isMyTurn() || !Net.active) return;
    this._aimSendT = (this._aimSendT || 0) + dt;
    if (this._aimSendT < 0.1) return;
    this._aimSendT = 0;
    Net.send({
      t: "aim",
      a: this.aimAngle,
      sx: this.spin.x,
      sy: this.spin.y,
      g: this.charging ? Math.min(1, this.charging.t / this.chargeDuration) : 0
    });
  },

  onNetMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.t) {
      case "hello":
        // B3: 상대 닉네임 교환 — 스코어보드에 반영 (textContent라 이스케이프 불필요)
        if (typeof msg.n === "string" && msg.n) {
          Net.peerNick = msg.n.slice(0, 12);
          if (this.mode === "online" && this.players.length === 2) {
            this.players[1 - this.myIdx].name = Net.peerNick;
            this.setupScoreboard();
          }
        }
        break;
      case "move": // F1: 상대의 자유 이동 좌표 (내 턴 동안 상대가 돌아다님)
        if (this.mode === "online" && Number.isFinite(msg.x) && Number.isFinite(msg.z) && Number.isFinite(msg.yaw)) {
          this._remoteRoam = { x: msg.x, z: msg.z, yaw: msg.yaw, m: !!msg.m };
        }
        break;
      case "correct": // B4: 서버 권위 판정 보정 (서버만 발신 가능 — 위조는 검증기가 차단)
        if (this.mode === "online") {
          this.applyResumeState(msg.snap);
          this.showToast("⚖️ 서버 판정으로 보정되었습니다");
        }
        break;
      case "start": // 게스트: 호스트가 확정한 설정으로 시작
        this.targetScore = msg.target || this.targetScore;
        this.startGame("online");
        break;
      case "aim": // 상대 조준 실시간 반영 (N3)
        if (this.mode === "online" && !this.isMyTurn() && this.state !== "ROLLING") {
          this.aimAngle = msg.a;
          this.setSpin(msg.sx, msg.sy);
          if (msg.g > 0) {
            this.updateGauge(msg.g, this.forceMin + (this.forceMax - this.forceMin) * msg.g);
          } else {
            this.updateGauge(0);
          }
        }
        break;
      case "shot": // 상대의 샷을 같은 물리로 재생 (N2)
        if (this.mode === "online" && !this.isMyTurn() && this.state !== "ROLLING") {
          if (msg.turn !== this.turnNo + 1) console.warn("샷 순번 불일치:", msg.turn, this.turnNo);
          this.fireShot(msg.p);
        }
        break;
      case "sync": // 호스트의 샷 종료 좌표로 보정 (N4, 게스트만)
        if (this.mode === "online" && !Net.isHost) {
          if (this.state === "ROLLING") this._pendingSync = msg; // 아직 굴러가는 중이면 정지 후 적용
          else this.applySync(msg);
        }
        break;
      case "rematch":
        if (this.mode === "online" || Net.active) {
          this.showToast("🔄 재대결!");
          this.startGame("online");
        }
        break;
      case "bye":
        this.onNetDisconnect();
        break;
    }
  },

  // N4: 부동소수점 미세 오차 안전망 — 호스트 기준 좌표로 스냅
  applySync(msg) {
    if (!msg || !msg.b) return;
    let corrected = false;
    msg.b.forEach((p, i) => {
      const b = this.balls[i];
      if (!b) return;
      if (Math.hypot(b.x - p[0], b.y - p[1]) > 1e-4) corrected = true;
      b.x = p[0];
      b.y = p[1];
      b.vx = 0;
      b.vy = 0;
    });
    if (corrected) console.warn("동기화 보정 적용 (턴", msg.turn, ")");
  },

  onNetDisconnect() {
    if (this.mode !== "online") return;
    this.showToast("⚠️ 상대와 연결이 끊어졌습니다");
    this.openMenu();
    this.mode = "solo"; // 온라인 상태 해제
    Net.cleanup();
  },

  /* ---------- R1: 재접속 & 몰수승 ---------- */
  // 상대(또는 서버) 끊김 → 입력을 막고 대기 오버레이 + 카운트다운 표시
  onNetPause(msg, graceSec) {
    if (this.mode !== "online" || this.state === "MENU") return;
    this.netPaused = true;
    this.charging = null;
    this.updateGauge(0);
    document.getElementById("pause-desc").textContent = msg;
    document.getElementById("overlay-pause").classList.add("show");
    clearInterval(this._pauseTimer);
    const cd = document.getElementById("pause-count");
    let left = graceSec || 0;
    cd.textContent = left > 0 ? `${left}초` : "";
    if (left > 0) {
      this._pauseTimer = setInterval(() => {
        left -= 1;
        cd.textContent = `${Math.max(0, left)}초`;
        if (left <= 0) clearInterval(this._pauseTimer);
      }, 1000);
    }
  },

  onNetResume(msg) {
    this.netPaused = false;
    clearInterval(this._pauseTimer);
    const ov = document.getElementById("overlay-pause");
    if (ov) ov.classList.remove("show");
    if (msg) this.showToast(msg);
  },

  // 내가 복귀했을 때: 게임 화면이 살아있으면(순간 끊김) 상태만 정렬,
  // 새로고침으로 처음부터 돌아온 경우면 씬을 새로 만들고 복원
  onGameResumed(res, auto) {
    if (auto && this.mode === "online" && this.state !== "MENU") {
      this.applyResumeState(res.snap);
      this.onNetResume("✅ 재연결됐습니다!");
    } else {
      this.resumeGame(res);
    }
    if (!res.peerConnected) this.onNetPause("상대 재접속 대기 중", res.graceLeft || 60);
  },

  resumeGame(res) {
    const snap = res.snap || {};
    if (Number.isFinite(snap.targetScore)) this.targetScore = snap.targetScore;
    this.startGame("online");
    this.applyResumeState(snap);
    this.showToast("⏪ 진행 중이던 게임으로 복귀했습니다");
  },

  // 서버 스냅샷(점수·차례·턴 번호·공 좌표)으로 현재 게임을 맞춤
  applyResumeState(snap) {
    if (!snap || this.mode !== "online") return;
    if (Array.isArray(snap.scores)) {
      this.players.forEach((p, i) => { if (Number.isFinite(snap.scores[i])) p.score = snap.scores[i]; });
    }
    if (Number.isFinite(snap.currentPlayer)) this.currentPlayer = snap.currentPlayer;
    if (Number.isFinite(snap.turnNo)) this.turnNo = snap.turnNo;
    const cur = this.players[this.currentPlayer];
    if (cur) this.cueIndex = cur.ballIndex;
    if (Array.isArray(snap.balls)) this.applySync({ b: snap.balls, turn: snap.turnNo });
    // 진행 중이던 충전/샷 연출은 무효화하고 조준 상태로 정리
    this.charging = null;
    this.cueAnim = null;
    this._pendingSync = null;
    if (this.state !== "MENU") {
      this.state = "AIM";
      this.updateGauge(0);
      this.refreshScores();
      this.highlightTurn();
      this.setActiveChar(this.currentPlayer);
      this.cueStick.visible = true;
      this.updateAimFromPointer();
      this.updateCueAim();
    }
  },

  // 상대가 유예 안에 돌아오지 않음 → 몰수승 (방은 서버에서 이미 제거됨)
  onForfeitWin() {
    if (this.mode !== "online") return;
    this.onNetResume();
    this.state = "MENU";
    this.mode = "solo"; // 온라인 상태 해제
    Net.cleanup();
    Sound.win();
    document.getElementById("win-title").textContent = "🏆 몰수승!";
    document.getElementById("win-desc").textContent = "상대가 돌아오지 않아 승리로 처리되었습니다";
    document.getElementById("btn-rematch").style.display = "none"; // 상대가 없어 재대결 불가
    document.getElementById("overlay-win").classList.add("show");
  },

  // 다시하기: 온라인이면 상대에게도 알리고 양쪽 모두 재시작
  requestRematch() {
    if (this.mode === "online" && Net.active) Net.send({ t: "rematch" });
    this.startGame(this.mode);
  },

  /* ---------- 당점(스핀) 위젯 ---------- */
  setSpin(x, y) {
    // 공 가장자리 끝까지는 못 치도록 최대 0.75로 제한 (미스큐 방지)
    const len = Math.hypot(x, y);
    const maxR = 0.75;
    if (len > maxR) { x *= maxR / len; y *= maxR / len; }
    this.spin.x = x;
    this.spin.y = y;

    const R = 36; // spin-ball 반지름(px)
    document.getElementById("spin-dot").style.transform =
      `translate(-50%, -50%) translate(${x * R}px, ${-y * R}px)`;
  },

  bindSpinWidget() {
    const ball = document.getElementById("spin-ball");
    const setFromEvent = (e) => {
      if (!this.isMyTurn()) return; // N2: 상대 턴에는 당점도 조작 불가
      const rect = ball.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const x = (e.clientX - cx) / (rect.width / 2);
      const y = -(e.clientY - cy) / (rect.height / 2);
      this.setSpin(x, y);
    };
    let dragging = false;
    ball.addEventListener("pointerdown", (e) => {
      dragging = true;
      ball.setPointerCapture(e.pointerId);
      setFromEvent(e);
      e.stopPropagation();
    });
    ball.addEventListener("pointermove", (e) => { if (dragging) setFromEvent(e); });
    ball.addEventListener("pointerup", (e) => {
      dragging = false;
      e.stopPropagation();
    });
    document.getElementById("spin-reset").addEventListener("click", () => this.setSpin(0, 0));
  },

  /* ---------- UI ---------- */
  showToast(msg) {
    const toast = document.getElementById("toast");
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
  },

  bindEvents() {
    const dom = this.renderer.domElement;

    dom.addEventListener("pointermove", (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
    });
    dom.addEventListener("pointerdown", (e) => {
      Sound.ensure(); // 첫 입력에서 오디오 활성화 (자동재생 정책)
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      if (e.button === 0) {
        if (this.state === "AIM") this.updateAimFromPointer(); // 터치: 누른 지점으로 즉시 조준
        this.beginCharge();
      } else if (e.button === 2) {
        this.cancelCharge(); // 충전 중 우클릭 = 샷 취소
      }
    });
    window.addEventListener("pointerup", (e) => {
      if (e.button === 0) this.releaseCharge();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.cancelCharge(); // ESC = 샷 취소
    });

    // F0: 프리롬 이동 키 (WASD/방향키) — 닉네임·코드 입력칸은 stopPropagation으로 제외됨
    this.keys = {};
    const roamKeyMap = {
      KeyW: "f", ArrowUp: "f", KeyS: "b", ArrowDown: "b",
      KeyA: "l", ArrowLeft: "l", KeyD: "r", ArrowRight: "r"
    };
    window.addEventListener("keydown", (e) => {
      const k = roamKeyMap[e.code];
      if (k) this.keys[k] = true;
    });
    window.addEventListener("keyup", (e) => {
      const k = roamKeyMap[e.code];
      if (k) this.keys[k] = false;
    });
    window.addEventListener("blur", () => { this.keys = {}; }); // 탭 전환 시 눌림 해제
    dom.addEventListener("contextmenu", (e) => e.preventDefault());

    // 시점 토글: 기본 ↔ 탑뷰 (버튼 라벨은 "전환하면 보게 될 시점")
    const viewBtn = document.getElementById("btn-view");
    this.viewMode = "default";
    viewBtn.addEventListener("click", () => {
      this.viewMode = this.viewMode === "default" ? "top" : "default";
      this.setCameraView(this.viewMode);
      viewBtn.textContent = this.viewMode === "default" ? "탑뷰" : "기본 시점";
    });
    document.getElementById("btn-reset").addEventListener("click", () => this.requestRematch());
    document.getElementById("btn-menu").addEventListener("click", () => this.openMenu());

    document.getElementById("btn-mode-solo").addEventListener("click", () => this.startGame("solo"));
    document.getElementById("btn-mode-versus").addEventListener("click", () => this.startGame("versus"));
    document.getElementById("btn-rematch").addEventListener("click", () => this.requestRematch());
    document.getElementById("btn-tomenu").addEventListener("click", () => this.openMenu());

    // N1: 온라인 대결 — 방 만들기 / 초대 코드 입장
    document.getElementById("btn-online-host").addEventListener("click", () => {
      Sound.ensure();
      Net.host();
    });
    document.getElementById("btn-online-join").addEventListener("click", () => {
      Sound.ensure();
      Net.join(document.getElementById("online-code").value);
    });
    document.getElementById("online-code").addEventListener("keydown", (e) => {
      if (e.key === "Enter") Net.join(e.target.value);
      e.stopPropagation(); // ESC 등 게임 키 입력과 분리
    });

    // B3: 닉네임 — 저장된 값 복원, 바뀌면 서버에 재등록
    const nickEl = document.getElementById("nick-input");
    try { nickEl.value = localStorage.getItem("billiard-nick") || ""; } catch (e) { /* 무시 */ }
    nickEl.addEventListener("change", () => Net.identify());
    nickEl.addEventListener("keydown", (e) => e.stopPropagation()); // ESC 등 게임 키와 분리

    // B2: 빠른 대전 + 공개 방 목록 입장
    document.getElementById("btn-online-quick").addEventListener("click", () => {
      Sound.ensure();
      Net.quickMatch();
    });
    document.getElementById("room-list").addEventListener("click", (e) => {
      const btn = e.target.closest(".room-join");
      if (btn) { Sound.ensure(); Net.join(btn.dataset.code); }
    });
    Net.startRoomListPolling();

    // R1: 진행 중이던 게임 복귀 (저장된 세션이 있을 때만 노출) + 대기 중 나가기
    const resumeBtn = document.getElementById("btn-online-resume");
    if (Net.loadSession()) resumeBtn.style.display = "";
    resumeBtn.addEventListener("click", () => {
      Sound.ensure();
      Net.resume(false);
    });
    document.getElementById("btn-pause-menu").addEventListener("click", () => this.openMenu());

    document.querySelectorAll(".target-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(".target-chip").forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        this.targetScore = parseInt(chip.dataset.target, 10);
      });
    });

    window.addEventListener("resize", () => this.resize());
  },

  init() {
    this.init3D();
    this.layoutBalls(); // 시작 화면 뒤 배경으로 테이블을 미리 보여줌
    this.bindEvents();
    this.bindSpinWidget();
    this.updateCueAim();
  }
};

/* =========================================================
   메인 루프
   ========================================================= */
Game.init();

let lastTs = null;
function loop(ts) {
  if (lastTs === null) lastTs = ts;
  const dt = Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;

  Game.update(dt);
  Game.render();

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
