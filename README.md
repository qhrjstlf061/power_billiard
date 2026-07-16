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

## 온라인 견고화 (R0~R4 완료)

`billiard-online-hardening-plan.md` 전 단계 구현됨:

- **R0 세션 상태**: 서버가 점수·턴·공 좌표 스냅샷 기록 (`/health`에서 확인)
- **R1 재접속**: 끊기면 60초 유예(`GRACE_SEC`) → 자동/수동 복귀, 초과 시 몰수승
- **R2 프로토콜 방어**: 스키마·턴·역할 검증, 레이트 리밋, 버전 핸드셰이크(v2 — 서버·클라 동시 변경!)
- **R3 방 수명**: 대기 방 10분·무활동 방 30분 자동 정리, 핑 배지(좌하단)
- **R4 배포 준비**: CORS 화이트리스트(`ALLOWED_ORIGINS`), 슬립 웨이크 안내, render.yaml

테스트: `npm start`가 필요 없음 — `npm test`가 자체 서버를 띄워 17단계 자동 검증.

## 배포 방법 (Render 무료)

이 폴더는 git 저장소로 준비돼 있음 (render.yaml 포함). 순서:

1. GitHub에서 새 저장소 만들기 (예: `power-billiard`)
2. `git remote add origin https://github.com/qhrjstlf061/power-billiard.git && git push -u origin master`
3. [render.com](https://render.com) 가입(GitHub 계정 연동) → **New → Blueprint** → 저장소 선택
   → render.yaml이 자동 적용되어 배포됨
4. 발급된 주소(`https://power-billiard.onrender.com` 식)로 접속 — 프론트+백엔드가 한 서비스
   (무료 티어는 15분 미접속 시 슬립 — 첫 접속 때 "서버 깨우는 중" 안내가 뜨고 ~30초 후 연결)

(선택) GitHub Pages에서 프론트를 따로 서빙하려면 `client/config.js`의
`window.BILLIARD_SERVER`에 Render 주소를 넣고 client 폴더를 Pages에 올리면 됨.
서버 환경변수 `ALLOWED_ORIGINS`에 Pages 주소가 들어 있어야 함.

## 다음 단계 (계획서 참고)

- B2: 방 목록·빠른 매칭
- B3: 닉네임·전적·랭킹 (SQLite)
- B4: 서버 권위 판정 (치트 방지, 선택)
