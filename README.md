# 🎱 power-billiard — 3D 4구 당구 (프론트엔드 + 백엔드)

단일 `billiard-game.html`(PeerJS P2P)을 **클라이언트-서버 구조**로 전환한 버전.
`billiard-fullstack-plan.md`의 Phase B0(경량)+B1 완료 상태.

## 실행 방법

```bash
cd power-billiard
npm install   # 최초 1회
npm start     # → http://localhost:3000
```

브라우저 두 개(또는 같은 와이파이의 폰)로 접속해서 한쪽이 "방 만들기",
다른 쪽이 초대 코드로 "입장"하면 온라인 대결이 시작됩니다.
같은 네트워크의 다른 기기에서는 `http://<이 컴퓨터 IP>:3000` 으로 접속.

## 구조

```
power-billiard/
├── package.json
├── server/
│   └── index.js       ← 백엔드: Express(정적 서빙) + Socket.IO(방 관리·메시지 릴레이)
└── client/            ← 프론트엔드
    ├── index.html     (마크업만)
    ├── style.css      (스타일 분리)
    ├── js/net.js      (네트워크 계층 — PeerJS → Socket.IO 릴레이로 교체)
    ├── js/game.js     (물리·렌더링·게임 로직 — 원본과 동일)
    ├── three.min.js
    └── OrbitControls.js
```

## 원본과 달라진 점

- **PeerJS(P2P) 제거 → Socket.IO 서버 릴레이**: NAT/공유기 환경에서도 안정적으로 연결.
  초대 코드는 이제 서버가 발급하고, 방 상태(호스트/게스트)를 서버가 관리.
- 게임 메시지 프로토콜(start/aim/shot/sync/rematch/bye)과 물리 계산 방식은 그대로 —
  서버는 내용을 해석하지 않고 상대에게 릴레이만 함.
- 게임 로직(`game.js`)은 원본에서 Net 블록만 제거한 것으로 동작 동일.

## 배포 (Phase B5, 아직 안 함)

- 백엔드: Render 등 Node 호스팅에 이 폴더를 배포 (`npm start`, PORT 환경변수 지원됨)
- 프론트를 GitHub Pages에서 서빙할 경우 `index.html`의 socket.io 스크립트 주소와
  `window.BILLIARD_SERVER = "https://백엔드주소"` 지정 필요 (net.js가 읽음)
- 기존 GitHub Pages(P2P 버전)는 검증 전까지 그대로 유지

## 다음 단계 (계획서 참고)

- B2: 방 목록·빠른 매칭·재접속
- B3: 닉네임·전적·랭킹 (SQLite)
- B4: 서버 권위 판정 (치트 방지, 선택)
