// 구글 포토 등 다른 앱에서 이미지를 "공유"로 고를 때 Vaulty가 공유 대상 목록에 뜨려면
// (안드로이드 Chrome에서만 지원 - iOS Safari는 이 manifest 기능 자체를 지원하지 않는다)
// 홈 화면에 Vaulty를 PWA로 설치해 둬야 하고, 이 서비스워커가 항상 등록돼 있어야 한다.
// 공유하면 브라우저가 manifest의 share_target.action(/share-target)으로 실제 파일이
// 담긴 POST 요청을 보내는데, 정적 사이트(백엔드 서버 없음)라 그 요청을 서버가 처리할
// 수 없다 - 그래서 여기서 파일을 잠깐 캐시에 저장해 두고 앱 화면으로 리다이렉트한다.
// App.jsx가 켜지면 이 캐시를 읽어서 실제 업로드(uploadEntries)를 이어서 진행한다.
const SHARE_CACHE_NAME = "vaulty-share-target-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(handleShareTarget(event));
  }
});

async function handleShareTarget(event) {
  try {
    const formData = await event.request.formData();
    const files = formData.getAll("images").filter((f) => f && typeof f.arrayBuffer === "function");
    const cache = await caches.open(SHARE_CACHE_NAME);
    await cache.put(
      "/__share-meta",
      new Response(JSON.stringify({ count: files.length }), { headers: { "content-type": "application/json" } })
    );
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      await cache.put(
        `/__share-file-${i}`,
        new Response(file, {
          headers: {
            "content-type": file.type || "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name || `shared-${i}`),
          },
        })
      );
    }
  } catch (err) {
    // 실패해도 홈으로는 보낸다 - 화면에서 캐시가 비어 있으면 조용히 아무 일도 안 한다.
  }
  return Response.redirect("/?share-target=1", 303);
}
