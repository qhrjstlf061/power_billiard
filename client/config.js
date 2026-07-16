"use strict";

/* =========================================================
   배포 설정 (R4)
   - 클라이언트를 백엔드(Node 서버)가 직접 서빙하면 빈 문자열 그대로 두세요.
     (로컬 npm start, Render 단일 서비스 배포 모두 이 경우)
   - GitHub Pages처럼 다른 곳에서 서빙할 때만 백엔드 주소를 지정:
     window.BILLIARD_SERVER = "https://power-billiard.onrender.com";
   ========================================================= */
window.BILLIARD_SERVER = "";
