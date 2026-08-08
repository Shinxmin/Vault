import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// 구글 포토 등에서 "공유"로 Vaulty를 골랐을 때 실제 파일을 받아 넘겨주는 서비스워커
// (public/sw.js) - manifest.webmanifest의 share_target과 짝을 이룬다. 등록만 해 두면
// 나머지(파일을 캐시에 저장하고 앱으로 리다이렉트하는 것)는 그 파일이 스스로 처리하고,
// 캐시에서 실제로 파일을 꺼내 업로드하는 건 App.jsx가 한다.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.error("서비스워커 등록 실패:", err));
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
