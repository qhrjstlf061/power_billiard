"use strict";

/* =========================================================
   네트워크 계층 (N1) — Socket.IO 서버 릴레이, 초대 코드 방식.
   PeerJS(P2P)를 백엔드 릴레이로 교체 — NAT 환경에서도 안정 연결.
   턴제 입력 동기화: 샷 파라미터만 주고받고 물리는 양쪽이 각자 계산.
   기존 Net API(isHost/active/send/cleanup/setStatus/host/join) 유지.
   ========================================================= */
const Net = {
  PROTOCOL_VERSION: 2, // R2: 서버(server/index.js)와 일치해야 함 — 프로토콜 바뀔 때 양쪽 다 올릴 것
  socket: null,
  isHost: false,
  active: false, // 상대와 연결되어 게임 중

  // 클라이언트를 다른 곳(GitHub Pages 등)에서 서빙할 때는
  // window.BILLIARD_SERVER = "https://내-백엔드-주소" 로 지정
  serverUrl() { return window.BILLIARD_SERVER || undefined; },

  setStatus(msg) {
    const el = document.getElementById("online-status");
    if (el) el.textContent = msg;
  },

  // R0: 재접속(R1)용 세션 저장 — 서버가 발급한 방 코드+토큰을 보관
  saveSession(code, token) {
    try {
      localStorage.setItem("billiard-session",
        JSON.stringify({ code, token, isHost: this.isHost, at: Date.now() }));
    } catch (e) { /* 시크릿 모드 등 저장 불가 환경은 무시 */ }
  },

  loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem("billiard-session"));
      // 2시간 넘은 세션은 서버에서 이미 정리됐을 것이므로 무시
      if (s && s.code && s.token && Date.now() - s.at < 2 * 3600 * 1000) return s;
    } catch (e) { /* 무시 */ }
    return null;
  },

  clearSession() {
    try { localStorage.removeItem("billiard-session"); } catch (e) { /* 무시 */ }
  },

  connect() {
    if (this.socket) return this.socket;
    this.socket = io(this.serverUrl());

    // R4: 무료 호스팅 슬립 웨이크 UX — 첫 연결이 오래 걸리면 안내
    this._wakeTimer = setTimeout(() => {
      if (this.socket && !this.socket.connected) {
        this.setStatus("서버를 깨우는 중... 최대 30초쯤 걸릴 수 있어요 ⏳");
      }
    }, 4000);

    this.socket.on("ready", () => {
      this.active = true;
      this.setStatus("연결됨!");
      this.pingNow(); // 핑 배지 즉시 갱신
      this.send({ t: "hello", v: this.PROTOCOL_VERSION });
      if (this.isHost) {
        // 호스트가 게임 설정을 확정하고 시작을 알림 (호스트 = 흰 공, 선공)
        this.send({ t: "start", target: Game.targetScore });
        Game.startGame("online");
      }
    });

    this.socket.on("msg", (msg) => Game.onNetMessage(msg));

    this.socket.on("peer-left", () => {
      const wasActive = this.active;
      this.active = false;
      this.setStatus("상대와 연결이 끊어졌습니다");
      if (wasActive) Game.onNetDisconnect();
    });

    // R1: 상대가 갑자기 끊김 → 유예 시간 동안 일시정지하고 기다림
    this.socket.on("peer-dropped", (d) => {
      Game.onNetPause("상대 연결 끊김 — 재접속 대기 중", (d && d.graceSec) || 60);
    });

    // R1: 상대 복귀 — 서버 스냅샷으로 상태를 맞추고 게임 재개
    this.socket.on("peer-resumed", (d) => {
      Game.applyResumeState(d && d.snap);
      Game.onNetResume("✅ 상대가 돌아왔습니다!");
    });

    // R1: 상대가 유예 안에 돌아오지 않음 → 몰수승
    this.socket.on("forfeit-win", () => {
      this.active = false;
      this.clearSession();
      Game.onForfeitWin();
    });

    // R2: 클라-서버 프로토콜 버전 불일치 (옛 캐시 페이지 등)
    this.socket.on("version-mismatch", () => {
      this.setStatus("클라이언트 버전이 다릅니다 — 새로고침(Ctrl+F5) 해주세요");
      this.clearSession();
      Game.onNetDisconnect();
    });

    // R3: 방치로 만료된 방 (서버가 정리함)
    this.socket.on("room-expired", () => {
      const wasActive = this.active;
      this.active = false;
      this.clearSession();
      this.setStatus("방이 오래 방치되어 만료되었습니다 — 새로 만들어주세요");
      const btn = document.getElementById("btn-online-resume");
      if (btn) btn.style.display = "none";
      if (wasActive) Game.onNetDisconnect();
    });

    this.socket.on("connect_error", () => this.setStatus("서버에 연결할 수 없습니다"));
    // R3: 자동 재연결 진행 상황 안내
    this.socket.io.on("reconnect_attempt", (n) => this.setStatus(`서버 재연결 중... (${n}번째 시도)`));

    // R1: 내 쪽 연결이 끊김 → Socket.IO 자동 재연결을 기다렸다가 resume 시도
    this.socket.on("disconnect", () => {
      if (!this.active) return;
      this.active = false;
      if (Game.mode === "online" && Game.state !== "MENU" && this.loadSession()) {
        this.pendingResume = true;
        this.setStatus("서버와 연결 끊김 — 재연결 중...");
        Game.onNetPause("서버와 연결이 끊겼습니다 — 재연결 중...", 60);
      } else {
        this.setStatus("서버와 연결이 끊어졌습니다");
        Game.onNetDisconnect();
      }
    });
    this.socket.on("connect", () => {
      clearTimeout(this._wakeTimer);
      if (this.pendingResume) { this.pendingResume = false; this.resume(true); }
    });
    this.startPing();
    return this.socket;
  },

  /* ---------- R3: 연결 품질(핑) 표시 ---------- */
  startPing() {
    clearInterval(this._pingTimer);
    this.pingNow();
    this._pingTimer = setInterval(() => this.pingNow(), 5000);
  },

  pingNow() {
    if (!this.socket || !this.socket.connected) { this.updatePingBadge(null); return; }
    const t0 = performance.now();
    this.socket.timeout(3000).emit("ping-check", (err) => {
      this.updatePingBadge(err ? null : Math.round(performance.now() - t0));
    });
  },

  updatePingBadge(ms) {
    const el = document.getElementById("ping-badge");
    if (!el) return;
    const show = this.active && typeof Game !== "undefined" && Game.mode === "online";
    el.style.display = show ? "block" : "none";
    if (!show) return;
    if (ms == null) { el.textContent = "···"; el.className = "bad"; return; }
    el.textContent = ms + "ms";
    el.className = ms < 150 ? "good" : ms < 300 ? "warn" : "bad"; // 150/300ms 기준 신호등
  },

  // R1: 재접속 — auto=true는 게임 중 끊겼다 자동 복귀, false는 새로고침 후 버튼 복귀
  resume(auto) {
    const s = this.loadSession();
    if (!s) { this.setStatus("복귀할 게임이 없습니다"); return; }
    this.setStatus("게임 복귀 중...");
    this.connect().emit("resume", { code: s.code, token: s.token, v: this.PROTOCOL_VERSION }, (res) => {
      if (res && res.ok) {
        this.isHost = res.isHost;
        this.active = true;
        this.setStatus("복귀 완료!");
        Game.onGameResumed(res, !!auto);
        this.pingNow();
      } else {
        this.clearSession();
        this.pendingResume = false;
        const btn = document.getElementById("btn-online-resume");
        if (btn) btn.style.display = "none";
        this.setStatus(res && res.error === "version"
          ? "클라이언트 버전이 다릅니다 — 새로고침(Ctrl+F5) 해주세요"
          : "복귀할 수 없습니다 — 게임이 이미 종료되었습니다");
        if (auto) Game.onNetDisconnect();
      }
    });
  },

  host() {
    this.cleanup();
    this.isHost = true;
    this.setStatus("방 생성 중...");
    this.connect().emit("host", (res) => {
      if (res && res.ok) {
        this.saveSession(res.code, res.token);
        this.setStatus(`초대 코드: ${res.code} — 상대를 기다리는 중...`);
      } else {
        const why = res && res.error === "server-full" ? "서버가 가득 찼습니다 — 잠시 후 다시 시도하세요"
                  : res && res.error === "rate" ? "요청이 너무 빠릅니다 — 잠시 후 다시 시도하세요"
                  : "방 생성 실패 — 잠시 후 다시 시도하세요";
        this.setStatus(why);
      }
    });
  },

  join(code) {
    code = (code || "").toUpperCase().trim();
    if (code.length < 4) { this.setStatus("초대 코드를 입력하세요"); return; }
    this.cleanup();
    this.isHost = false;
    this.setStatus("접속 중...");
    this.connect().emit("join", code, (res) => {
      if (res && res.ok) { this.saveSession(res.code, res.token); return; } // 곧 "ready" 이벤트가 와서 게임 시작
      const why = res && res.error === "no-room" ? "해당 코드의 방이 없습니다"
                : res && res.error === "full" ? "방이 가득 찼습니다"
                : res && res.error === "rate" ? "요청이 너무 빠릅니다 — 잠시 후 다시 시도하세요"
                : "입장 실패 — 코드를 확인하세요";
      this.setStatus(why);
    });
  },

  send(obj) {
    if (this.socket && this.socket.connected) this.socket.emit("msg", obj);
  },

  cleanup() {
    this.active = false;
    this.pendingResume = false;
    this.clearSession(); // 의도적 종료 — 복귀 대상 아님
    this.updatePingBadge(null); // 배지 즉시 숨김
    if (this.socket) this.socket.emit("leave");
  }
};
