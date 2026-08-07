import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { supabase } from "./supabaseClient";

// 앱 버전 표기 - v0.1.N, N은 현재까지 main에 병합된 PR(변경 라운드) 번호.
const APP_VERSION = "0.1.98";

// 한 폴더 안의 항목이 이 개수를 넘으면 가상 스크롤링으로 그린다. 그 아래에서는
// 예전처럼 전부 그대로 그린다 - DOM이 적을 때는 가상화 오버헤드가 더 손해다.
const VIRTUALIZE_THRESHOLD = 40;

// 가상 스크롤링(윈도우 스크롤 기준) 목록 - 화면(+여유분)에 걸치는 항목만 실제 DOM에
// 그리고, 나머지 자리는 전체 높이를 가진 빈 컨테이너로만 잡아 둔다. 파일이 수백~수천 개인
// 폴더에서도 DOM 노드 수가 화면에 보이는 만큼으로 유지돼 스크롤이 부드럽다.
// 항목 높이는 제각각이므로(제목 줄 수, 태그 줄, 이미지 비율) 추정치로 시작해서 실제로
// 그려진 높이를 measureElement로 다시 재 정확한 위치를 잡는다.
function WindowVirtualList({ count, estimateSize, overscan = 6, renderItem }) {
  const parentRef = useRef(null);
  // 목록이 문서 맨 위에서 얼마나 떨어져 있는지 - 윈도우 스크롤 좌표를 목록 내부
  // 좌표로 바꾸는 기준점이다. 위쪽 콘텐츠(폴더 목록, 이미지 로딩 등)의 높이가 바뀌면
  // 같이 바뀌므로 body 크기 변화를 지켜보며 다시 잰다.
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      if (!parentRef.current) return;
      const top = parentRef.current.getBoundingClientRect().top + window.scrollY;
      setScrollMargin((prev) => (Math.abs(prev - top) > 0.5 ? top : prev));
    };
    measure();
    window.addEventListener("resize", measure);
    let observer = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(document.body);
    }
    return () => {
      window.removeEventListener("resize", measure);
      if (observer) observer.disconnect();
    };
  }, []);

  const virtualizer = useWindowVirtualizer({
    count,
    estimateSize: () => estimateSize,
    overscan,
    scrollMargin,
  });

  return (
    <div ref={parentRef} style={{ position: "relative", width: "100%", height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((virtualRow) => (
        <div
          key={virtualRow.key}
          data-index={virtualRow.index}
          ref={virtualizer.measureElement}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            // flow-root - 새 BFC를 만들어서 자식의 margin-bottom(행 사이 8px 간격)이
            // 바깥으로 새지 않고 이 칸의 높이에 포함되게 한다(그래야 실측 높이가 맞다).
            display: "flow-root",
            transform: `translateY(${virtualRow.start - scrollMargin}px)`,
          }}
        >
          {renderItem(virtualRow.index)}
        </div>
      ))}
    </div>
  );
}

// 배열을 n개씩 잘라 2차원 배열로 만든다 - 2열 그리드를 "한 줄"씩 가상화할 때 쓴다.
const chunkArray = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// 마크다운 실시간 편집기(contentEditable) 커서 위치 저장/복원 - 문자 오프셋(전체
// 텍스트 기준 몇 번째 글자인지) 하나로 표현한다. 매 입력마다 DOM을 통째로 다시 그리기
// 때문에(문법 적용 결과를 그 자리에 바로 보여주려면 필요) 브라우저가 스스로 커서를
// 옮겨주지 못하므로 직접 계산해서 되돌려야 한다.
const getCaretOffset = (root) => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return 0;
  const preRange = range.cloneRange();
  preRange.selectNodeContents(root);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
};

const setCaretOffset = (root, offset) => {
  const sel = window.getSelection();
  if (!sel) return;
  let remaining = offset;
  let targetNode = null;
  let targetOffset = 0;
  const walk = (el) => {
    for (const child of el.childNodes) {
      if (targetNode) return;
      if (child.nodeType === Node.TEXT_NODE) {
        const len = child.textContent.length;
        if (remaining <= len) {
          targetNode = child;
          targetOffset = remaining;
          return;
        }
        remaining -= len;
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  const range = document.createRange();
  if (targetNode) {
    range.setStart(targetNode, targetOffset);
  } else {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
};

// 지금 선택 범위의 시작/끝을 문자 오프셋으로 - 아무것도 선택하지 않고 커서만 있으면
// start===end(=getCaretOffset과 같은 값)이고, 드래그로 여러 글자를 선택한 채 타이핑/
// 삭제하면 그 구간 전체를 교체해야 하므로 둘 다 필요하다.
const getSelectionOffsets = (root) => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { start: 0, end: 0 };
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return { start: 0, end: 0 };
  const offsetOf = (container, off) => {
    const r = document.createRange();
    r.selectNodeContents(root);
    r.setEnd(container, off);
    return r.toString().length;
  };
  const start = offsetOf(range.startContainer, range.startOffset);
  const end = offsetOf(range.endContainer, range.endOffset);
  return start <= end ? { start, end } : { start: end, end: start };
};

export default function Alloy() {
  // 아이폰 사파리는 100vh가 주소창을 뺀 실제 화면보다 커서 콘텐츠가 없어도
  // 스크롤이 생기므로, 실제 뷰포트 높이(window.innerHeight)를 추적해 사용
  const [vh, setVh] = useState(() => (typeof window !== "undefined" ? window.innerHeight : 800));
  useEffect(() => {
    const updateVh = () => setVh(window.innerHeight);
    updateVh();
    window.addEventListener("resize", updateVh);
    window.addEventListener("orientationchange", updateVh);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", updateVh);
    }
    return () => {
      window.removeEventListener("resize", updateVh);
      window.removeEventListener("orientationchange", updateVh);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", updateVh);
      }
    };
  }, []);

  const [theme, setTheme] = useState("dark"); // "dark" | "light" | "sunset" | "forest"
  const THEME_SWATCHES = {
    light: "#FAF9F5",
    dark: "#141413",
    sunset: "radial-gradient(circle at 50% 50%, #47301e 0%, #2a1f1a 55%, #17191D 95%)",
    forest: "radial-gradient(circle at 50% 50%, #1f3d28 0%, #1a2a20 55%, #17191D 95%)",
  };
  const [themeLoaded, setThemeLoaded] = useState(false);
  const isLight = theme === "light";
  // 설정 탭의 라이트/다크 스위치 - sunset/forest 테마는 그대로 두고 light<->dark만 오간다.
  // "시스템 설정"이 켜져 있는 동안은 수동 전환을 막는다.
  const toggleLightDark = () => {
    if (useSystemTheme) return;
    setTheme(isLight ? "dark" : "light");
  };

  // 시스템 설정 - 켜면 OS/브라우저의 라이트·다크 모드(아이폰/안드로이드/윈도우/맥 등)를
  // 그대로 따라가고, 위 수동 스위치는 비활성화된다.
  const [useSystemTheme, setUseSystemTheme] = useState(false);
  const toggleUseSystemTheme = () => setUseSystemTheme((v) => !v);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("alloy_theme");
      const savedUseSystem = localStorage.getItem("alloy_use_system_theme") === "true";
      setUseSystemTheme(savedUseSystem);
      if (!savedUseSystem && (saved === "light" || saved === "sunset" || saved === "forest")) setTheme(saved);
    } catch (e) {}
    setThemeLoaded(true);
  }, []);

  useEffect(() => {
    if (!themeLoaded) return;
    try {
      localStorage.setItem("alloy_theme", theme);
    } catch (e) {}
  }, [theme, themeLoaded]);

  useEffect(() => {
    if (!themeLoaded) return;
    try {
      localStorage.setItem("alloy_use_system_theme", String(useSystemTheme));
    } catch (e) {}
  }, [useSystemTheme, themeLoaded]);

  // 상단 상태 표시줄(와이파이/배터리 등이 보이는 영역)까지 배경색이 이어져 보이도록,
  // 라이트/다크(및 sunset/forest) 전환마다 <meta name="theme-color">를 갱신한다.
  // sunset/forest는 그라디언트라 메타 태그에 그대로 쓸 수 없어 배경 톤에 맞춘 단색으로 대체한다.
  const STATUS_BAR_COLORS = {
    light: "#FFFFFF",
    dark: "#141413",
    sunset: "#2a1f1a",
    forest: "#1a2a20",
  };
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", STATUS_BAR_COLORS[theme] || STATUS_BAR_COLORS.dark);
  }, [theme]);

  // 시스템 설정이 켜져 있으면 OS 다크모드 여부를 즉시 반영하고, 이후 시스템에서
  // 라이트/다크가 바뀔 때마다(아이폰 설정, 윈도우 자동 전환 등) 따라간다.
  useEffect(() => {
    if (!useSystemTheme || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const applySystemTheme = () => setTheme(mq.matches ? "dark" : "light");
    applySystemTheme();
    mq.addEventListener("change", applySystemTheme);
    return () => mq.removeEventListener("change", applySystemTheme);
  }, [useSystemTheme]);

  const BAR_HEIGHT = 58;
  // 홈 탭의 추가하기(+) 버튼과 휴지통 화면의 닫기(X) 버튼 크기 - 검색 버튼(BAR_HEIGHT)의 2/3.
  const TOP_BUTTON_SIZE = Math.round((BAR_HEIGHT * 2) / 3);
  // 데스크탑처럼 넓은 화면에서 콘텐츠(홈 탭/설정 화면)가 가로로 무한정 늘어나지 않도록
  // 이 폭에서 잘라내고 가운데 정렬한다. 화면 배경(고정 배경 레이어)은 이 폭과 무관하게 항상
  // 뷰포트 전체를 채운다.
  const CONTENT_MAX_WIDTH = 640;

  // 상단 헤더 중앙의 검색창 - 항상 떠 있는 인라인 입력창(예전처럼 버튼을 눌러 열고 닫는
  // 패널이 아니다). 검색어가 있으면 홈 탭 메인 섹션이 현재 위치와 상관없이 이름에
  // 검색어가 포함된 전체 폴더/파일/이미지 리스트로 바뀐다(아래 홈 탭 렌더링 부분 참고).
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef(null);

  // Vaulty 데이터 모델: Folder(폴더) > Data(이미지) - 홈이 곧 최상위 폴더다(예전의
  // Vault 계층은 없앴다 - 폴더/데이터를 홈에 바로 만들 수 있다).
  //  - folders: path 는 자기 이름까지 포함하는 조상 경로. 홈 바로 아래 폴더는 path.length === 1.
  //  - files: path 는 소속 디렉터리(홈이면 []). kind 는 'image' | 'doc'
  //    · 이미지/움짤(JPG/JPEG/PNG/GIF/APNG/WEBP)만 업로드 가능
  //    · doc/text kind는 예전 버전에서 만들어진 문서가 남아있을 수 있어 표시만 계속 지원한다.
  const [currentPath, setCurrentPath] = useState([]); // [] = 홈(최상위 폴더/데이터 목록)
  const [folders, setFolders] = useState([]);
  const [files, setFiles] = useState([]);

  // R2 presigned URL 발급 - 실제 파일 업로드/다운로드/삭제는 Supabase Edge Function이
  // 발급한 presigned URL로 브라우저가 R2에 직접 요청한다(R2 시크릿 키는 서버에만 보관됨).
  const r2Presign = async (payload) => {
    const { data, error } = await supabase.functions.invoke("r2-presign", { body: payload });
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    return data;
  };

  // 정렬 - 단일 "ABC" 버튼 하나로 가나다순 -> 숫자순 -> 알파벳순을 순환한다.
  // (예전에 있던 "사용자 지정"(꾹 눌러서 드래그로 순서 바꾸기) 정렬은 없앴다 - 꾹 누르기는
  //  이제 선택 기능이다.)
  const SORT_MODES = ["ko", "num", "en"];
  const [sortModeIndex, setSortModeIndex] = useState(0);
  // storageLimitGB는 아래 load/save 이펙트의 의존성 배열에서 참조하므로 그보다 먼저
  // 선언해야 한다(안 그러면 TDZ로 "Cannot access before initialization" 런타임 에러가 난다).
  const [storageLimitGB, setStorageLimitGB] = useState(10);
  // 업로드 방식 - 설정 탭의 "업로드" 카드에서 원본/최적화 스위치로 고른다. 최적화면
  // 이미지/움짤만 원본 해상도의 50%로 줄여서 올린다(기본값은 원본 - 손대지 않고 그대로 올림).
  const [uploadOptimizeEnabled, setUploadOptimizeEnabled] = useState(false);
  // 보기(리스트/갤러리) - 마법사 메뉴의 "보기"를 누르면 지금 보고 있는 위치의 폴더/문서/
  // 이미지 전부가 똑같이 리스트형 <-> 갤러리형으로 바뀐다. 위치별로 따로 기억한다
  // (예: 홈에서 켜도 그 안의 하위 폴더까지 적용되지 않는다).
  // gallery_view_paths 컬럼에 저장해 새로고침/로그아웃 후 다시 로그인해도 유지된다.
  const [galleryViewPaths, setGalleryViewPaths] = useState({}); // { [pathKey]: true }
  const currentPathKey = currentPath.join("/");
  const galleryMode = !!galleryViewPaths[currentPathKey];
  const toggleGalleryMode = () => {
    setGalleryViewPaths((prev) => ({ ...prev, [currentPathKey]: !prev[currentPathKey] }));
  };
  // 로그인 - 개인 웹사이트라 회원가입 기능은 없고, Supabase Auth에 미리 등록해 둔
  // 계정(들)으로만 로그인할 수 있다(가입 화면이 없으니 등록 안 된 계정은 애초에
  // signInWithPassword 자체가 실패한다). vaulty_state.user_id가 그 계정의
  // 데이터가 들어있는 행을 가리킨다. 비로그인 상태에서는 폴더/파일 등은 전혀
  // 불러오지 않고(웹드라이브 이용 불가), 게시글만 항상 공개된 'default' 행에서 읽는다.
  const [authUser, setAuthUser] = useState(null); // { id, username } | null
  const [authLoading, setAuthLoading] = useState(true);
  const [myRowId, setMyRowId] = useState("default"); // 로그인 계정의 vaulty_state 행 id
  const [authIdDraft, setAuthIdDraft] = useState("");
  const [authPasswordDraft, setAuthPasswordDraft] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const sortMode = SORT_MODES[sortModeIndex];
  const cycleSortMode = () => {
    setSortModeIndex((i) => (i + 1) % SORT_MODES.length);
  };

  // 예전에 만든 항목은 createdAt/updatedAt 없이 저장돼 있을 수 있는데(이 필드를 넣기 전
  // 버전에서 생성됨), id 자체가 Date.now() 기반 타임스탬프라 생성 시각의 대체값으로 쓸 수
  // 있다. "정보" 모달에 빈 값이 뜨지 않도록 불러올 때 항상 유효한 날짜를 채워 넣는다.
  const withDates = (item) => {
    const createdAt = item.createdAt || Math.floor(item.id);
    return { ...item, createdAt, updatedAt: item.updatedAt || createdAt };
  };

  // Vaulty 상태(폴더/파일 목록) 영구 저장 - 계정별로 vaulty_state의 한 행(row)에
  // 저장한다. 파일의 실제 바이트는 R2에 있고 files[].r2Key로 R2 객체를 가리킨다.
  const [dataLoaded, setDataLoaded] = useState(false);
  // 휴지통 - 삭제된 폴더/파일(이미지)은 바로 지워지지 않고 여기 담겨 7일간
  // 보관된다. trash 컬럼은 이후에 추가된 것이라 아직 마이그레이션을 안 돌린 환경에서는
  // 없을 수 있으므로, select("*")로 있으면 읽고 없으면 빈 배열로 취급한다.
  const [trash, setTrash] = useState([]);
  const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  // vaulty_state 한 행을 상태로 반영하는 공용 유틸 - 최초 비로그인 로드와 로그인 직후
  // 둘 다 이 함수를 쓴다. 이미지 표시용 url은 만료되는 presigned URL이라 DB에 저장하지
  // 않으므로 불러올 때마다 r2Key 기준으로 새로 발급받는다(휴지통 안 이미지도 포함).
  // 예전 Vault 계층을 쓰던 계정의 데이터를 위한 1회성 비파괴 변환 - Vault 하나하나를
  // 홈 바로 아래의 평범한 폴더로 취급한다. 하위 폴더/파일의 path는 이미 예전 Vault 이름을
  // 첫 세그먼트로 갖고 있으므로 그대로 두면 새로 만든 폴더 밑으로 자연스럽게 들어간다.
  const migrateVaultsToFolders = (vaults) => (vaults || []).map((v) => withDates({ ...v, path: [v.name] }));

  const hydrateFromRow = async (row) => {
    const loadedFolders = [...migrateVaultsToFolders(row.vaults), ...(row.folders || []).map(withDates)];
    const loadedFiles = (row.files || []).map(withDates);
    const loadedTrash = row.trash || [];
    setFolders(loadedFolders);
    setStorageLimitGB(typeof row.storage_limit_gb === "number" && row.storage_limit_gb > 0 ? row.storage_limit_gb : 10);
    setUploadOptimizeEnabled(row.upload_optimize_enabled === true);
    setGalleryViewPaths(row.gallery_view_paths && typeof row.gallery_view_paths === "object" ? row.gallery_view_paths : {});
    const trashImageKeys = loadedTrash.flatMap((t) => t.files || []).filter((f) => f.kind === "image" && f.r2Key).map((f) => f.r2Key);
    const imageKeys = [...loadedFiles.filter((f) => f.kind === "image" && f.r2Key).map((f) => f.r2Key), ...trashImageKeys];
    if (imageKeys.length) {
      try {
        const { urls } = await r2Presign({ action: "get-batch", keys: imageKeys });
        const withUrl = (f) => (f.kind === "image" && f.r2Key ? { ...f, url: urls[f.r2Key] || null } : f);
        setFiles(loadedFiles.map(withUrl));
        setTrash(loadedTrash.map((t) => ({ ...t, files: (t.files || []).map(withUrl) })));
      } catch (e) {
        console.error("이미지 URL 발급 실패:", e);
        setFiles(loadedFiles);
        setTrash(loadedTrash);
      }
    } else {
      setFiles(loadedFiles);
      setTrash(loadedTrash);
    }
  };

  // 로그인 세션을 실제 앱 상태로 반영한다 - 이 계정의 vaulty_state 행을 찾아
  // 데이터를 불러온다. 아직 어떤 계정에도 연결되지 않은 'default' 행이 있다면(처음
  // 로그인하는 계정인 경우) 그동안 로그인 없이 써오던 기존 데이터를 그대로 이 계정
  // 데이터로 이어받는다 - 회원가입 화면이 없으니 이 "최초 로그인 시 이어받기"가
  // 유일한 연결 시점이다.
  const applySession = async (user) => {
    const username = (user.email || "").split("@")[0];
    let row = null;
    const byUser = await supabase.from("vaulty_state").select("*").eq("user_id", user.id).maybeSingle();
    row = byUser.data;
    if (!row) {
      const { data: legacyRow } = await supabase.from("vaulty_state").select("id, user_id").eq("id", "default").maybeSingle();
      if (legacyRow && !legacyRow.user_id) {
        await supabase.from("vaulty_state").update({ user_id: user.id }).eq("id", "default");
        const claimed = await supabase.from("vaulty_state").select("*").eq("id", "default").maybeSingle();
        row = claimed.data;
      } else {
        const inserted = await supabase
          .from("vaulty_state")
          .insert({ id: user.id, user_id: user.id })
          .select("*")
          .maybeSingle();
        row = inserted.data;
      }
    }
    if (row) {
      setMyRowId(row.id);
      await hydrateFromRow(row);
    }
    setAuthUser({ id: user.id, username });
  };

  // 로그아웃/비로그인 상태로 되돌린다 - 데이터는 화면에서 완전히 사라진다.
  const clearMyData = () => {
    setAuthUser(null);
    setMyRowId("default");
    setFolders([]);
    setFiles([]);
    setTrash([]);
    setCustomOrderActive(false);
    setStorageLimitGB(10);
    setUploadOptimizeEnabled(false);
    setGalleryViewPaths({});
    setCurrentPath([]);
  };

  useEffect(() => {
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (sessionData && sessionData.session && sessionData.session.user) {
        try {
          await applySession(sessionData.session.user);
        } catch (e) {
          console.error("로그인 정보를 불러오지 못했습니다:", e);
        }
      }
      setDataLoaded(true);
      setAuthLoading(false);
    })();

    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") clearMyData();
    });
    return () => authListener.subscription.unsubscribe();
  }, []);

  // 동기화 상태 - 홈/폴더 화면 하단 중앙에 작게 "☁ 동기화"로 보여준다. 폴더 생성/이미지
  // 업로드 등으로 바뀐 내용이 실제로 DB(아래 저장 이펙트)에 정상 반영되는 동안은 계속
  // 표기하고, 저장이 실패하거나(네트워크 오류 등) 아예 인터넷이 끊기면 숨긴다 - 사용자가
  // "지금 내 변경사항이 안전하게 저장되고 있는지"를 감으로 알 수 있게 하는 용도다.
  const [dbSyncOk, setDbSyncOk] = useState(true);
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // 초기 로드가 끝난 뒤부터 folders/files 등이 바뀔 때마다 살짝
  // 지연을 두고(짧은 시간 내 연속 변경을 한 번으로 묶어) Supabase에 저장한다. 로그인
  // 상태가 아니면 애초에 보여줄 데이터가 없으므로(웹드라이브는 로그인 전용) 절대
  // 저장을 시도하지 않는다 - 이 가드가 없으면 로그인 전 빈 상태가 실제 계정 데이터가
  // 든 행을 빈 배열로 덮어써버리는 사고로 이어진다.
  const saveTimerRef = useRef(null);
  useEffect(() => {
    if (!dataLoaded || !authUser) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      // url은 만료되는 presigned URL이라 저장하지 않고 r2Key만 저장한다.
      const filesToSave = files.map(({ url, ...rest }) => rest);
      supabase
        .from("vaulty_state")
        .upsert({
          id: myRowId,
          user_id: authUser.id,
          // vaults는 더 이상 쓰지 않는 예전 컬럼 - 로드 시 폴더로 변환해 흡수했으므로
          // 매번 빈 배열로 써서 다음 로드 때 같은 항목이 폴더로 중복 변환되지 않게 한다.
          vaults: [],
          folders,
          files: filesToSave,
          // 사용자 지정 정렬 기능은 없앴지만 컬럼은 그대로 두고 항상 false로 쓴다.
          custom_order_active: false,
          storage_limit_gb: storageLimitGB,
          upload_optimize_enabled: uploadOptimizeEnabled,
          gallery_view_paths: galleryViewPaths,
          updated_at: new Date().toISOString(),
        })
        .then(({ error }) => {
          if (error) {
            // 저장이 실패하면(예: 컬럼 스키마가 아직 반영되지 않은 경우) 콘솔 로그만으로는
            // 사용자가 알아챌 방법이 없어 새로고침하면 변경 내용이 통째로 사라진 것처럼
            // 보인다 - 눈에 보이는 안내를 반드시 함께 띄운다.
            console.error("Vaulty 상태 저장 실패:", error);
            showToast("저장에 실패했습니다. 새로고침하지 마세요");
            setDbSyncOk(false);
          } else {
            setDbSyncOk(true);
          }
        });
    }, 800);
    return () => clearTimeout(saveTimerRef.current);
  }, [folders, files, storageLimitGB, uploadOptimizeEnabled, galleryViewPaths, dataLoaded, authUser, myRowId]);

  // 로그인 - 개인 웹사이트라 회원가입은 없고, Supabase Auth 대시보드에 미리 등록해 둔
  // 계정(이메일/비밀번호)으로만 로그인할 수 있다. 등록되지 않은 이메일이거나 비밀번호가
  // 틀리면 Supabase가 둘을 구분하지 않고 동일한 오류를 주므로, 굳이 구분해서 알려주지
  // 않고 하나의 안내 문구로만 처리한다(등록된 계정이 무엇인지 짐작할 단서를 주지 않기 위함이기도 하다).
  const handleLogin = async () => {
    const email = authIdDraft.trim();
    const pw = authPasswordDraft;
    if (!email || !pw || authBusy) return;
    setAuthBusy(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password: pw });
      if (error || !data.session) { showToast("아이디 또는 비밀번호가 올바르지 않습니다"); return; }
      await applySession(data.user);
      setAuthIdDraft("");
      setAuthPasswordDraft("");
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    clearMyData();
  };

  // 휴지통은 별도 컬럼(trash)에 저장한다. 위 저장과 분리해 둔 이유는, 이 컬럼이 아직
  // 없는(마이그레이션 전) 환경에서 이 upsert가 실패하더라도 vaults/folders/files 등
  // 핵심 데이터 저장에는 영향이 없도록 하기 위해서다.
  const trashSaveTimerRef = useRef(null);
  useEffect(() => {
    if (!dataLoaded) return;
    if (trashSaveTimerRef.current) clearTimeout(trashSaveTimerRef.current);
    trashSaveTimerRef.current = setTimeout(() => {
      const trashToSave = trash.map((t) => ({ ...t, files: (t.files || []).map(({ url, ...rest }) => rest) }));
      supabase
        .from("vaulty_state")
        .upsert({ id: "default", trash: trashToSave, updated_at: new Date().toISOString() })
        .then(({ error }) => {
          if (error) console.error("휴지통 저장 실패 (supabase/vaulty_schema.sql의 trash 컬럼 마이그레이션이 필요할 수 있습니다):", error);
        });
    }, 800);
    return () => clearTimeout(trashSaveTimerRef.current);
  }, [trash, dataLoaded]);

  // 휴지통에 7일 넘게 있던 항목은 자동으로 영구 삭제(R2 객체까지 정리)한다.
  // 마운트 시 한 번, 이후 1시간마다 다시 확인한다.
  useEffect(() => {
    if (!dataLoaded) return;
    const purgeExpired = () => {
      const now = Date.now();
      setTrash((prev) => {
        const expired = prev.filter((t) => now - t.deletedAt > TRASH_RETENTION_MS);
        expired.forEach((entry) => {
          (entry.files || []).forEach((f) => {
            if (f.r2Key) r2Presign({ action: "delete", key: f.r2Key }).catch((e) => console.error("R2 삭제 실패:", e));
          });
        });
        return prev.filter((t) => now - t.deletedAt <= TRASH_RETENTION_MS);
      });
    };
    purgeExpired();
    const interval = setInterval(purgeExpired, 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, [dataLoaded]);

  const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "apng", "webp"];
  const getKindFromName = (name) => {
    const ext = (name.split(".").pop() || "").toLowerCase();
    return IMAGE_EXTS.includes(ext) ? "image" : null;
  };
  // 파일 이름에서 확장자를 떼어낸다 - 제목(item.name)에는 확장자를 담지 않고, 확장자는
  // 항목의 ext 필드에 따로 저장해서 정보 모달의 "확장자" 행 등에서만 쓴다.
  const splitNameExt = (fullName) => {
    const idx = fullName.lastIndexOf(".");
    if (idx <= 0) return { base: fullName, ext: "" };
    return { base: fullName.slice(0, idx), ext: fullName.slice(idx + 1).toLowerCase() };
  };

  const [trashCloseButtonHovered, setTrashCloseButtonHovered] = useState(false);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [uploadMenuVisible, setUploadMenuVisible] = useState(false);
  // 업로드 메뉴 드롭다운 위치 - backdropFilter가 걸린 상단 헤더 안에 있으면 position:fixed
  // 오버레이가 뷰포트가 아닌 헤더를 기준으로 잡히므로(모든 filter/backdrop-filter/transform
  // 속성은 fixed 자손의 컨테이닝 블록을 새로 만든다), 드롭다운을 document.body로 포탈하고
  // 버튼의 화면 좌표를 직접 계산해 고정 위치로 띄운다.
  const uploadButtonRef = useRef(null);
  const [uploadMenuAnchor, setUploadMenuAnchor] = useState({ top: 0, right: 0 });
  // "마법사" 버튼 - 예전 "ABC" 정렬 버튼 자리를 대체. 누르면 "정렬"(기존 ABC 순환)과
  // "변환"(일괄 이름 변환) 두 옵션이 드롭다운으로 뜬다. 업로드 메뉴와 동일한 포탈+고정좌표 패턴.
  const wizardButtonRef = useRef(null);
  const [wizardMenuOpen, setWizardMenuOpen] = useState(false);
  const [wizardMenuVisible, setWizardMenuVisible] = useState(false);
  const [wizardMenuAnchor, setWizardMenuAnchor] = useState({ top: 0, right: 0 });
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderModalVisible, setFolderModalVisible] = useState(false);
  const [folderName, setFolderName] = useState("");
  // 폴더/파일 삼점 메뉴 - 리스트/갤러리 통틀어 한 번에 하나만 열리도록 단일 상태로 관리한다.
  // 이 메뉴 역시 backdropFilter가 걸린 행(row) 안에 있으므로 위와 같은 이유로 포탈 + 고정 좌표를 쓴다.
  const [itemMenuOpen, setItemMenuOpen] = useState(null); // { type: 'folder' | 'file', id }
  const [itemMenuVisibleKey, setItemMenuVisibleKey] = useState(null);
  const [itemMenuAnchor, setItemMenuAnchor] = useState({ top: 0, right: 0 });
  // 삭제 - 확인 문구 없이, 삭제 버튼을 한 번 누르면 배경이 붉게 변하고(armed) 같은
  // 버튼을 한 번 더 누르면 그때 실제로 삭제된다. 폴더/파일(이미지) 전부 공용.
  const [deleteArmedKey, setDeleteArmedKey] = useState(null); // `${type}-${id}`
  const galleryInputRef = useRef(null);
  // 갤러리 카드의 실제 가로세로 비율(width/height) - 이미지가 로드되면 채워 넣어서
  // 구글 포토처럼 빈틈없는 매이슨리(masonry) 배치를 계산하는 데 쓴다. 로드 전에는
  // 정사각형(1)으로 가정한다.
  const [imgAspect, setImgAspect] = useState({});
  const handleImgAspectLoad = (id) => (e) => {
    const { naturalWidth, naturalHeight } = e.target;
    if (!naturalWidth || !naturalHeight) return;
    const ratio = naturalWidth / naturalHeight;
    setImgAspect((prev) => (prev[id] === ratio ? prev : { ...prev, [id]: ratio }));
  };


  // 설정 화면 - 상단 우측 설정(⚙) 버튼을 누르면 전체화면으로 열린다. 그 안에서 휴지통은
  // 화면을 하나 더 미는 방식(별도 탭이 아니라 이 설정 화면 안의 하위 화면).
  const [settingsScreenOpen, setSettingsScreenOpen] = useState(false);
  const [settingsButtonHovered, setSettingsButtonHovered] = useState(false);
  // 문서 화면 상단의 수정하기/닫기 버튼 호버 상태 - 설정 버튼과 똑같은 리퀴드 글라스
  // 원형 버튼 디자인을 그대로 쓴다.
  const [docEditButtonHovered, setDocEditButtonHovered] = useState(false);
  const [docCloseButtonHovered, setDocCloseButtonHovered] = useState(false);
  const [trashScreenOpen, setTrashScreenOpen] = useState(false);
  // 안내 팝업 - "청구 금액"/"업로드" 카드 제목 오른쪽 물음표 아이콘을 누르면 하단 서브
  // 액션바와 같은 리퀴드 글래스 배경을 가진 별도의 뜬 패널이 그 아이콘 바로 밑 위치에
  // 2초간 페이드 인/아웃으로 떴다가 사라진다(레이아웃 흐름에 얹혀 다른 내용을 밀어내지
  // 않고, document.body에 포탈로 띄운다). kind로 어떤 카드의 물음표인지 구분해 내용만 바꾼다.
  const [infoPopupKind, setInfoPopupKind] = useState(null); // 'pricing' | 'upload' | null
  const [infoPopupVisible, setInfoPopupVisible] = useState(false);
  const [infoPopupPos, setInfoPopupPos] = useState({ top: 0, left: 0 });
  const infoPopupShowTimerRef = useRef(null);
  const infoPopupHideTimerRef = useRef(null);
  const showInfoPopup = (kind, buttonEl) => {
    if (infoPopupShowTimerRef.current) clearTimeout(infoPopupShowTimerRef.current);
    if (infoPopupHideTimerRef.current) clearTimeout(infoPopupHideTimerRef.current);
    if (buttonEl) {
      const rect = buttonEl.getBoundingClientRect();
      setInfoPopupPos({ top: rect.bottom + 8, left: rect.left });
    }
    setInfoPopupKind(kind);
    requestAnimationFrame(() => setInfoPopupVisible(true));
    infoPopupHideTimerRef.current = setTimeout(() => {
      setInfoPopupVisible(false);
      infoPopupShowTimerRef.current = setTimeout(() => setInfoPopupKind(null), 300);
    }, 2000);
  };
  // 휴지통 항목의 복구/삭제 - 다른 항목들과 같은 우측 끝 삼점 메뉴 패턴으로 담는다.
  const [trashItemMenuOpen, setTrashItemMenuOpen] = useState(null); // 휴지통 항목 id
  const [trashItemMenuVisible, setTrashItemMenuVisible] = useState(false);
  const [trashItemMenuAnchor, setTrashItemMenuAnchor] = useState({ top: 0, right: 0 });
  const openTrashItemMenu = (id, anchorEl) => {
    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      setTrashItemMenuAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setTrashItemMenuOpen(id);
    requestAnimationFrame(() => setTrashItemMenuVisible(true));
  };
  const closeTrashItemMenu = () => {
    setTrashItemMenuVisible(false);
    setTimeout(() => setTrashItemMenuOpen(null), 200);
  };
  const toggleTrashItemMenu = (id, anchorEl) => {
    if (trashItemMenuOpen === id) closeTrashItemMenu();
    else openTrashItemMenu(id, anchorEl);
  };

  // 저장 공간 - 기본 10GB, "한도"를 눌러 직접 늘려서 설정할 수 있다(storageLimitGB,
  // 위에서 미리 선언됨). 사용량은 files + 휴지통에 남아있는 파일 크기 합.
  const STORAGE_MAX_BYTES = storageLimitGB * 1024 * 1024 * 1024;
  // 텍스트 에디터에서 타이핑할 때마다 앱 전체가 리렌더되는데, 이 계산들이 매번 새로
  // 돌면(특히 allTags/tagTargets는 전체 폴더·파일을 훑는다) 입력이 밀리면서 스페이스 등
  // 키 입력이 여러 번 뭉쳐 들어가는 것처럼 보일 수 있어 실제 값이 바뀔 때만 다시 계산한다.
  // attachments는 이미 있는 파일을 참조만 하는 것(원본을 복제하지 않음)이라 저장 공간
  // 사용량 계산에 별도로 더하지 않는다 - 참조 대상 파일의 용량은 files 합계에 이미 잡혀 있다.
  const usedStorageBytes = useMemo(() =>
    files.reduce((s, f) => s + (f.size || 0), 0) +
    trash.reduce((s, t) => s + (t.files || []).reduce((s2, f) => s2 + (f.size || 0), 0), 0),
  [files, trash]);
  const formatGBShort = (bytes) => {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb % 1 === 0 ? gb : gb.toFixed(1)}GB`;
  };

  // 저장 공간 한도 편집 - "한도 설정"을 누르면 "0.0GB/10GB"의 "10GB" 부분이 직접 입력
  // 가능한 인풋으로 바뀐다. 포커스를 벗어나거나 Enter를 누르면 커밋된다. 10~1,000GB 범위
  // 밖이면 적용하지 않고 원래 값으로 되돌리며 서브 액션바로 안내한다.
  const STORAGE_LIMIT_MIN_GB = 10;
  const STORAGE_LIMIT_MAX_GB = 1000;
  const [storageLimitEditing, setStorageLimitEditing] = useState(false);
  const [storageLimitDraft, setStorageLimitDraft] = useState("");
  const startEditStorageLimit = () => {
    setStorageLimitDraft(String(storageLimitGB));
    setStorageLimitEditing(true);
  };
  const commitStorageLimit = () => {
    const parsed = parseFloat(storageLimitDraft);
    if (isNaN(parsed)) {
      setStorageLimitEditing(false);
      return;
    }
    if (parsed < STORAGE_LIMIT_MIN_GB) {
      showToast("10GB 미만으로 설정할 수 없습니다");
    } else if (parsed > STORAGE_LIMIT_MAX_GB) {
      showToast("1TB 초과하여 설정할 수 없습니다");
    } else {
      setStorageLimitGB(parsed);
    }
    setStorageLimitEditing(false);
  };
  // 한도 표시 전용 포맷 - 1,000GB(=1TB)일 때만 "1TB"로 보여주고, 999GB 이하는 그대로 GB로 보여준다.
  const formatStorageLimitDisplay = (gb) => (gb >= 1000 ? "1TB" : formatGBShort(gb * 1024 * 1024 * 1024));

  // 예상 청구 금액 - 한도가 아니라 실제 지금 사용 중인 용량 기준으로, 할당된 10GB를
  // 초과한 만큼만 GB당 $0.15를 곱한다.
  const usedStorageGB = usedStorageBytes / (1024 * 1024 * 1024);
  const billingOverageGB = Math.max(0, usedStorageGB - 10);
  const billingAmount = billingOverageGB * 0.15;

  // 하단 탭바 바로 위에 뜨는 서브 액션바 - "데이터를 삭제했습니다"/"데이터를 복구했습니다"처럼
  // 짧은 안내 문구를 2초간 페이드 인/아웃으로 보여주고 사라진다.
  const [toastMessage, setToastMessage] = useState(null);
  const [toastVisible, setToastVisible] = useState(false);
  const toastShowTimerRef = useRef(null);
  const toastHideTimerRef = useRef(null);
  const showToast = (message) => {
    if (toastShowTimerRef.current) clearTimeout(toastShowTimerRef.current);
    if (toastHideTimerRef.current) clearTimeout(toastHideTimerRef.current);
    setToastMessage(message);
    requestAnimationFrame(() => setToastVisible(true));
    toastHideTimerRef.current = setTimeout(() => {
      setToastVisible(false);
      toastShowTimerRef.current = setTimeout(() => setToastMessage(null), 300);
    }, 1700);
  };

  // 경로 세그먼트 버튼 클릭 시 그 세그먼트 자신까지 포함해서 이동해야 한다.
  // slice(0, index)로 자기 자신을 빼먹으면 A>B에서 A를 눌러도 A 화면이 아니라
  // 그 위(홈)로 튕겨나가는 버그가 생긴다.
  const navigateToBreadcrumb = (index) => {
    setCurrentPath(currentPath.slice(0, index + 1));
  };

  // 업로드 메뉴 - 부드러운 페이드/슬라이드 애니메이션을 위해 마운트(open)와
  // 실제 트랜지션 시작(visible)을 한 프레임 지연시켜 분리한다.
  const openUploadMenu = () => {
    if (uploadButtonRef.current) {
      const rect = uploadButtonRef.current.getBoundingClientRect();
      setUploadMenuAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setUploadMenuOpen(true);
    requestAnimationFrame(() => setUploadMenuVisible(true));
  };
  const closeUploadMenu = () => {
    setUploadMenuVisible(false);
    setTimeout(() => setUploadMenuOpen(false), 200);
  };
  const toggleUploadMenu = () => {
    if (uploadMenuOpen) closeUploadMenu();
    else openUploadMenu();
  };

  const openWizardMenu = () => {
    if (wizardButtonRef.current) {
      const rect = wizardButtonRef.current.getBoundingClientRect();
      setWizardMenuAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setWizardMenuOpen(true);
    requestAnimationFrame(() => setWizardMenuVisible(true));
  };
  const closeWizardMenu = () => {
    setWizardMenuVisible(false);
    setTimeout(() => setWizardMenuOpen(false), 200);
  };
  const toggleWizardMenu = () => {
    if (wizardMenuOpen) closeWizardMenu();
    else openWizardMenu();
  };

  const openFolderModal = () => {
    setFolderModalOpen(true);
    requestAnimationFrame(() => setFolderModalVisible(true));
  };
  const closeFolderModal = () => {
    setFolderModalVisible(false);
    setTimeout(() => {
      setFolderModalOpen(false);
      setFolderName("");
    }, 200);
  };

  // 삼점 메뉴를 연 3점 버튼 그 자체를 기억해 뒀다가, 열려 있는 동안 스크롤이 생기면
  // 그 버튼의 현재 화면 위치를 다시 재서 메뉴가 계속 따라가게 한다.
  const itemMenuAnchorElRef = useRef(null);
  const openItemMenu = (type, id, anchorEl) => {
    if (anchorEl) {
      itemMenuAnchorElRef.current = anchorEl;
      const rect = anchorEl.getBoundingClientRect();
      setItemMenuAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setItemMenuOpen({ type, id });
    requestAnimationFrame(() => setItemMenuVisibleKey(`${type}-${id}`));
  };
  const closeItemMenu = () => {
    setItemMenuVisibleKey(null);
    setDeleteArmedKey(null);
    setTimeout(() => setItemMenuOpen(null), 200);
  };
  const toggleItemMenu = (type, id, anchorEl) => {
    if (itemMenuOpen && itemMenuOpen.type === type && itemMenuOpen.id === id) closeItemMenu();
    else openItemMenu(type, id, anchorEl);
  };

  // 삼점 메뉴가 열려 있는 동안 위아래로 스크롤하면(가상 스크롤링 목록 포함) 메뉴가
  // 화면에 고정된 채 남아 원래 열었던 행에서 동떨어져 보이던 것을, 그 행을 계속
  // 따라가도록 위치를 다시 잰다. 스크롤이 그 행이 화면 밖으로 완전히 사라지게(가상
  // 목록에서 DOM째 제거되게) 만들면 더 이상 위치를 알 수 없으므로 메뉴를 닫는다.
  useEffect(() => {
    if (!itemMenuOpen) return;
    const reposition = () => {
      const el = itemMenuAnchorElRef.current;
      if (!el || !el.isConnected) {
        closeItemMenu();
        return;
      }
      const rect = el.getBoundingClientRect();
      setItemMenuAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    };
    window.addEventListener("scroll", reposition, { passive: true, capture: true });
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, { capture: true });
      window.removeEventListener("resize", reposition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemMenuOpen]);

  const createFolder = () => {
    if (folderName.trim()) {
      const now = Date.now();
      const newFolder = {
        id: now,
        name: folderName,
        path: [...currentPath, folderName],
        createdAt: now,
        updatedAt: now,
      };
      setFolders([...folders, newFolder]);
    }
    closeFolderModal();
  };

  // 새 문서 만들기 모달 - 신규 메뉴의 "새 문서"를 누르면 뜬다. 폴더 만들기와 똑같은
  // 모달 UI(제목 입력 + 취소/확인)를 그대로 쓰고, 확인하면 지금 위치에 빈 마크다운
  // 문서(.md)를 만들어 바로 편집 화면을 연다. 파일의 실제 내용(content)은 이미지처럼
  // R2에 올리지 않고 다른 텍스트 필드(태그 등)와 마찬가지로 vaulty_state에 그대로 저장한다.
  const [docCreateModalOpen, setDocCreateModalOpen] = useState(false);
  const [docCreateModalVisible, setDocCreateModalVisible] = useState(false);
  const [docNameDraft, setDocNameDraft] = useState("");
  const openDocCreateModal = () => {
    setDocNameDraft("");
    setDocCreateModalOpen(true);
    requestAnimationFrame(() => setDocCreateModalVisible(true));
  };
  const closeDocCreateModal = () => {
    setDocCreateModalVisible(false);
    setTimeout(() => {
      setDocCreateModalOpen(false);
      setDocNameDraft("");
    }, 200);
  };
  const createDoc = () => {
    const name = docNameDraft.trim();
    if (!name) {
      closeDocCreateModal();
      return;
    }
    const now = Date.now();
    const id = now;
    const newDoc = {
      id,
      name,
      ext: "md",
      kind: "doc",
      mimeType: "text/markdown",
      content: "",
      size: 0,
      path: currentPath,
      createdAt: now,
      updatedAt: now,
    };
    setFiles((prev) => [...prev, newDoc]);
    closeDocCreateModal();
    openDocScreen(id, "edit");
  };

  // 문서 화면 - 마크다운 문서를 읽거나 편집하는 전체화면. 별도 저장 버튼 없이 다른
  // 항목들과 동일하게 편집하는 즉시 자동 저장된다(디바운스 저장 이펙트가 files 전체를
  // 지켜본다). "편집" 모드에서는 원문 입력창과 그 아래 실시간 렌더링 미리보기를 함께
  // 보여주고, "보기" 모드에서는 렌더링 결과만 전체 화면에 꽉 차게 보여준다.
  const [docScreenOpen, setDocScreenOpen] = useState(false);
  const [docScreenId, setDocScreenId] = useState(null);
  const [docScreenMode, setDocScreenMode] = useState("view"); // "view" | "edit"
  const openDocScreen = (id, mode = "view") => {
    setDocScreenId(id);
    setDocScreenMode(mode);
    setDocScreenOpen(true);
  };
  const closeDocScreen = () => {
    setDocScreenOpen(false);
    setDocScreenId(null);
  };
  const docScreenFile = docScreenId ? files.find((f) => f.id === docScreenId) : null;
  const updateDocContent = (id, content) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, content, size: new Blob([content]).size, updatedAt: Date.now() } : f))
    );
  };

  // ── 마크다운 실시간 편집 ──────────────────────────────────────────────────
  // 편집 화면은 별도 미리보기 없이, 지금 쓰고 있는 본문 그 자리에서 문법이 바로
  // 적용되어 보인다(굵게/기울임/제목 등). 문법 기호(**, #, - 등)는 원문 보존과
  // 안전한 다시 편집을 위해 화면에 흐리게 남겨 두고, 그 사이 내용만 스타일을 입힌다.
  // 리액트가 매번 이 영역을 다시 그리면 커서가 튀고 한글 조합 입력(IME)이 깨지므로,
  // 이 DOM은 리액트 트리 밖에서 우리가 직접 소유하고(ref), 입력마다 우리가 직접
  // 다시 그린 뒤 커서 위치도 직접 계산해 되돌린다.
  const docEditableRef = useRef(null);
  const docComposingRef = useRef(false);

  // 인접한 일반 텍스트(특히 빈 줄이 이어질 때 줄 사이 개행들)를 서로 다른 텍스트
  // 노드로 쪼개 놓으면, 그 경계에 커서가 있을 때 브라우저가 실제로 타이핑을 어느
  // 노드에 반영할지 애매해져 문자가 사라지는 경우가 있다(특히 내용 맨 끝의 개행).
  // 그래서 실제 엘리먼트(문법 기호 span, 굵게/기울임 등)를 넣기 직전에만 지금까지
  // 모아둔 일반 텍스트를 하나의 텍스트 노드로 묶어서 내보낸다.
  const makeMarkdownSink = (container, colors) => {
    let buffer = "";
    const flush = () => {
      if (buffer) {
        container.appendChild(document.createTextNode(buffer));
        buffer = "";
      }
    };
    const pushText = (s) => { buffer += s; };
    const pushEl = (el) => { flush(); container.appendChild(el); };
    const pushMarker = (str) => {
      const span = document.createElement("span");
      span.style.color = colors.muted;
      span.textContent = str;
      pushEl(span);
    };
    const pushInline = (str) => {
      const patterns = [
        { re: /\*\*([^*]+)\*\*/, wrap: "strong", markerLen: 2 },
        { re: /~~([^~]+)~~/, wrap: "s", markerLen: 2 },
        { re: /`([^`]+)`/, wrap: "code", markerLen: 1 },
        { re: /\*([^*]+)\*/, wrap: "em", markerLen: 1 },
        { re: /_([^_]+)_/, wrap: "em", markerLen: 1 },
      ];
      let rest = str;
      while (rest.length) {
        let earliest = null;
        let earliestPattern = null;
        patterns.forEach((p) => {
          const m = rest.match(p.re);
          if (m && (earliest === null || m.index < earliest.index)) {
            earliest = m;
            earliestPattern = p;
          }
        });
        if (!earliest) {
          pushText(rest);
          break;
        }
        if (earliest.index > 0) pushText(rest.slice(0, earliest.index));
        const markLen = earliestPattern.markerLen;
        pushMarker(earliest[0].slice(0, markLen));
        const inner = document.createElement(earliestPattern.wrap);
        if (earliestPattern.wrap === "code") {
          inner.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";
          inner.style.fontSize = "0.9em";
          inner.style.padding = "1px 4px";
          inner.style.borderRadius = "4px";
          inner.style.background = colors.codeBg;
        }
        inner.appendChild(document.createTextNode(earliest[1]));
        pushEl(inner);
        pushMarker(earliest[0].slice(-markLen));
        rest = rest.slice(earliest.index + earliest[0].length);
      }
    };
    return { pushText, pushEl, pushMarker, pushInline, flush };
  };

  const headingSizes = { 1: "1.6em", 2: "1.35em", 3: "1.2em", 4: "1.1em", 5: "1em", 6: "0.95em" };

  const buildLiveMarkdownFragment = (text) => {
    const colors = {
      muted: isLight ? "rgba(20,22,26,0.32)" : "rgba(255,255,255,0.38)",
      codeBg: isLight ? "rgba(20,22,26,0.08)" : "rgba(255,255,255,0.12)",
      quote: isLight ? "rgba(20,22,26,0.6)" : "rgba(255,255,255,0.65)",
    };
    const root = document.createDocumentFragment();
    const sink = makeMarkdownSink(root, colors);
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const headerMatch = line.match(/^(#{1,6})(\s+)(.*)$/);
      const listMatch = line.match(/^(\s*)([-*+]|\d+\.)(\s+)(.*)$/);
      const quoteMatch = line.match(/^(>\s?)(.*)$/);

      if (headerMatch) {
        sink.pushMarker(headerMatch[1] + headerMatch[2]);
        const span = document.createElement("span");
        span.style.fontWeight = "700";
        span.style.fontSize = headingSizes[headerMatch[1].length] || "1em";
        const innerSink = makeMarkdownSink(span, colors);
        innerSink.pushInline(headerMatch[3]);
        innerSink.flush();
        sink.pushEl(span);
      } else if (listMatch) {
        if (listMatch[1]) sink.pushText(listMatch[1]);
        sink.pushMarker(listMatch[2] + listMatch[3]);
        sink.pushInline(listMatch[4]);
      } else if (quoteMatch) {
        sink.pushMarker(quoteMatch[1]);
        const span = document.createElement("span");
        span.style.color = colors.quote;
        const innerSink = makeMarkdownSink(span, colors);
        innerSink.pushInline(quoteMatch[2]);
        innerSink.flush();
        sink.pushEl(span);
      } else {
        sink.pushInline(line);
      }
      if (i < lines.length - 1) sink.pushText("\n");
    });
    sink.flush();
    return root;
  };

  // 지금 입력창에 있는 텍스트를 다시 스타일링해서 그려 넣고, 편집 중이었다면 커서
  // 위치도 그대로 되돌린다.
  const restyleDocEditable = (text) => {
    const el = docEditableRef.current;
    if (!el) return;
    const focused = document.activeElement === el;
    const offset = focused ? getCaretOffset(el) : 0;
    el.innerHTML = "";
    el.appendChild(buildLiveMarkdownFragment(text));
    if (focused) setCaretOffset(el, offset);
  };

  // 텍스트를 실제로 바꾸고 다시 그린다 - 타이핑/삭제/줄바꿈이 전부 이 한 함수를 거친다.
  const applyDocEdit = (id, el, newText, newOffset) => {
    updateDocContent(id, newText);
    el.innerHTML = "";
    el.appendChild(buildLiveMarkdownFragment(newText));
    setCaretOffset(el, newOffset);
  };

  // 타이핑/삭제/줄바꿈을 브라우저의 기본 DOM 수정에 맡기지 않고 여기서 전부 직접
  // 처리한다. white-space:pre-wrap + contentEditable 조합은 문서 끝에 빈 줄이
  // 이어질 때 등 브라우저마다 미묘하게 문자를 잃어버리는 경우가 있어서(Range API나
  // execCommand 모두 신뢰할 수 없었다), 문자열을 직접 잘라 끼워넣고 통째로 다시
  // 그린 뒤 커서 위치도 직접 계산해 되돌리는 방식으로 통일했다. 한글 등 조합 입력
  // (IME) 중에는 손대지 않고 조합이 끝난 뒤(compositionend)에만 반영한다 - 조합
  // 중간에 DOM을 갈아치우면 조합이 끊긴다.
  // 리액트의 onBeforeInput 합성 이벤트는 이 환경에서 실제 브라우저의 beforeinput
  // (InputEvent, inputType 있음)이 아니라 옛 textInput 이벤트로 대체되어 넘어와
  // inputType/data가 항상 undefined였다(Enter는 아예 발생하지도 않아 브라우저
  // 기본 동작이 그대로 실행돼 <div>가 끼어들었다). 그래서 리액트를 거치지 않고
  // ref로 DOM에 직접 네이티브 이벤트 리스너를 붙인다.
  const handleDocEditableCompositionEnd = (id) => () => {
    docComposingRef.current = false;
    restyleDocEditable(docEditableRef.current.textContent);
  };

  // 편집 화면에 처음 들어올 때 또는 다른 문서로 바뀌었을 때 한 번 그려 넣고, 그
  // 이후의 모든 타이핑/삭제/줄바꿈은 네이티브 beforeinput 리스너가 직접 처리한다
  // (리액트 상태가 바뀌어도 이 DOM을 리액트가 다시 만지지 않아야 커서가 안 튄다).
  useEffect(() => {
    const el = docEditableRef.current;
    if (docScreenMode !== "edit" || !el || !docScreenFile) return;
    const id = docScreenFile.id;
    el.innerHTML = "";
    el.appendChild(buildLiveMarkdownFragment(docScreenFile.content || ""));

    const onBeforeInput = (e) => {
      if (docComposingRef.current) return;
      const inputType = e.inputType;
      if (inputType === "historyUndo" || inputType === "historyRedo") {
        e.preventDefault();
        return;
      }
      const handledTypes = ["insertText", "insertParagraph", "insertLineBreak", "deleteContentBackward", "deleteContentForward"];
      if (!handledTypes.includes(inputType)) return;
      e.preventDefault();
      const text = el.textContent;
      let { start, end } = getSelectionOffsets(el);
      let insert = "";
      if (inputType === "insertText") insert = e.data || "";
      else if (inputType === "insertParagraph" || inputType === "insertLineBreak") insert = "\n";
      else if (inputType === "deleteContentBackward" && start === end) start = Math.max(0, start - 1);
      else if (inputType === "deleteContentForward" && start === end) end = Math.min(text.length, end + 1);
      const newText = text.slice(0, start) + insert + text.slice(end);
      applyDocEdit(id, el, newText, start + insert.length);
    };
    el.addEventListener("beforeinput", onBeforeInput);
    return () => el.removeEventListener("beforeinput", onBeforeInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docScreenMode, docScreenId]);

  // 폴더를 지우면 그 안의 하위 폴더/파일도 통째로 하나의 휴지통 항목으로 담는다.
  const deleteFolder = (folderId) => {
    const folder = folders.find((f) => f.id === folderId);
    if (!folder) { closeItemMenu(); return; }
    const descFolders = folders.filter((f) => f.id !== folder.id && pathStartsWith(f.path, folder.path));
    const descFiles = files.filter((f) => pathStartsWith(f.path, folder.path));
    setTrash((prev) => [...prev, {
      id: Date.now(),
      type: "folder",
      name: folder.name,
      deletedAt: Date.now(),
      folder,
      folders: descFolders,
      files: descFiles,
    }]);
    setFolders((prev) => prev.filter((f) => f.id !== folder.id && !pathStartsWith(f.path, folder.path)));
    setFiles((prev) => prev.filter((f) => !pathStartsWith(f.path, folder.path)));
    closeItemMenu();
    showToast("데이터를 삭제했습니다");
  };

  // 정렬 - 단일 "ABC" 버튼 하나로 가나다순 -> 숫자순 -> 알파벳순을 순환한다.
  // localeCompare에 { numeric: true }를 줘서 이름 안에 섞인 숫자를 문자 하나씩이 아니라
  // 값 그대로 비교한다 - 안 그러면 "예시(10)"이 "예시(2)"보다 앞에 온다("1" < "2"라서).
  // 이 옵션을 주면 "예시(1)", "예시(2)", ..., "예시(9)", "예시(10)" 순서로 정렬된다.
  const sortItems = (items) => {
    const sorted = [...items];
    if (sortMode === "num") {
      sorted.sort((a, b) => {
        const na = parseFloat(a.name);
        const nb = parseFloat(b.name);
        const aIsNum = !isNaN(na);
        const bIsNum = !isNaN(nb);
        if (aIsNum && bIsNum) return na - nb;
        if (aIsNum) return -1;
        if (bIsNum) return 1;
        return a.name.localeCompare(b.name, "en", { numeric: true });
      });
    } else if (sortMode === "en") {
      sorted.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true }));
    }
    return sorted;
  };

  // 검색 결과/"분류" 화면 전용 정렬 - 현재 정렬 모드와 무관하게
  // 항상 가나다순으로 보여준다(폴더는 별도 섹션으로 이미지보다 먼저 렌더링되어 항상 최상단에 온다).
  // sortItems와 마찬가지로 숫자는 값 그대로 비교한다.
  const koSort = (items) => [...items].sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true }));

  // 선택 - 폴더/데이터를 꾹 누르면(롱프레스) 그 항목이 선택되고 선택 모드로 들어간다.
  // (예전에는 꾹 누르면 드래그로 순서를 바꾸는 "사용자 지정 이동"이었는데 그 기능은 없앴다.)
  // 선택 모드에서는 항목을 그냥 눌러도 폴더로 들어가거나 이미지 뷰어가 열리지 않고
  // 선택/해제만 토글된다. 마지막 하나까지 해제하면 자동으로 선택 모드가 풀린다.
  const [selectedKeys, setSelectedKeys] = useState({}); // { "folder-<id>": true, "file-<id>": true }
  const selectionCount = Object.keys(selectedKeys).length;
  const selectionMode = selectionCount > 0;
  const isSelected = (type, id) => !!selectedKeys[`${type}-${id}`];
  const toggleSelected = (type, id) => {
    setSelectedKeys((prev) => {
      const key = `${type}-${id}`;
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });
  };
  const clearSelection = () => setSelectedKeys({});
  // 선택된 항목들을 실제 폴더/파일 객체로 되돌린다(다운로드/변환/태그에서 함께 쓴다).
  const selectedFolders = useMemo(
    () => folders.filter((f) => selectedKeys[`folder-${f.id}`]),
    [folders, selectedKeys]
  );
  const selectedFiles = useMemo(
    () => files.filter((f) => selectedKeys[`file-${f.id}`]),
    [files, selectedKeys]
  );

  const longPressTimerRef = useRef(null);
  const longPressStartRef = useRef(null);
  const justLongPressedRef = useRef(false); // 롱프레스 직후 따라오는 click을 무시하기 위한 플래그

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const rowPointerDown = (type, id) => (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    longPressStartRef.current = { x: e.clientX, y: e.clientY };
    // 새 누름이 시작됐으니 직전 롱프레스 표시는 지운다. 이 플래그는 시간이 아니라
    // "뒤따라오는 click 한 번을 먹었는지"로 풀어야 한다 - 시간으로 풀면 손가락을
    // 오래 대고 있다가 떼는 순간 그 click이 방금 선택한 항목을 도로 해제해 버린다.
    justLongPressedRef.current = false;
    clearLongPressTimer();
    longPressTimerRef.current = setTimeout(() => {
      justLongPressedRef.current = true;
      toggleSelected(type, id);
    }, 450);
  };
  const rowPointerMove = (e) => {
    if (!longPressStartRef.current) return;
    const dx = e.clientX - longPressStartRef.current.x;
    const dy = e.clientY - longPressStartRef.current.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearLongPressTimer();
  };
  const rowPointerUp = () => clearLongPressTimer();

  // 이름 바꾸기 - 별도 모달 없이, 현재 화면에서 해당 항목의 제목 텍스트를 인라인 입력창으로
  // 바꿔서 바로 수정한다. 입력 후 포커스를 벗어나면(blur) 자동으로 저장된다.
  const [editingItem, setEditingItem] = useState(null); // { type: 'folder' | 'file', id }
  const [editingValue, setEditingValue] = useState("");

  const startInlineEdit = (type, id, currentName) => {
    setEditingItem({ type, id });
    setEditingValue(currentName);
  };
  // path가 prefix로 시작하는지, 그리고 그 prefix를 다른 prefix로 바꿔치기하는 헬퍼.
  // 폴더 이름을 바꿀 때 그 하위의 모든 폴더/파일 path를 갱신하는 데 공용으로 쓴다
  // (깊이에 상관없이 동작 - 예전에는 폴더 이름을 바꾸면 하위 이미지의 path가 갱신되지 않아
  // 화면에서 사라지는 버그가 있었다).
  const pathStartsWith = (path, prefix) =>
    path.length >= prefix.length && prefix.every((seg, i) => path[i] === seg);
  const rebasePath = (path, oldPrefix, newPrefix) => [...newPrefix, ...path.slice(oldPrefix.length)];

  const commitInlineEdit = () => {
    if (!editingItem) return;
    const newName = editingValue.trim();
    if (newName) {
      if (editingItem.type === "folder") {
        const folder = folders.find((f) => f.id === editingItem.id);
        if (folder) {
          const oldPrefix = folder.path;
          const newPrefix = [...oldPrefix.slice(0, -1), newName];
          setFolders((prev) => prev.map((f) => {
            if (f.id === editingItem.id) return { ...f, name: newName, path: newPrefix, updatedAt: Date.now() };
            return pathStartsWith(f.path, oldPrefix) ? { ...f, path: rebasePath(f.path, oldPrefix, newPrefix) } : f;
          }));
          setFiles((prev) => prev.map((f) => (pathStartsWith(f.path, oldPrefix) ? { ...f, path: rebasePath(f.path, oldPrefix, newPrefix) } : f)));
        }
      } else {
        setFiles((prev) => prev.map((f) => (f.id === editingItem.id ? { ...f, name: newName, updatedAt: Date.now() } : f)));
      }
    }
    setEditingItem(null);
    setEditingValue("");
  };

  // 변환(일괄 이름 변경) 모달 - "마법사" 메뉴의 "변환"을 누르면 뜬다. 지금 보고 있는
  // 위치(홈 포함)의 하위 폴더·파일·이미지들을 체크해서 한 번에 새 이름으로 바꾼다.
  const [convertModalOpen, setConvertModalOpen] = useState(false);
  const [convertModalVisible, setConvertModalVisible] = useState(false);
  const [convertChecked, setConvertChecked] = useState({}); // { [id]: true }
  const [convertDrafts, setConvertDrafts] = useState({}); // { [id]: 미리보기용 새 이름 }
  const [convertInput, setConvertInput] = useState("");

  const convertTargets = useMemo(() => {
    const items = [
      ...folders
        .filter((f) => f.path.length === currentPath.length + 1 && f.path.slice(0, currentPath.length).every((p, i) => p === currentPath[i]))
        .map((f) => ({ id: f.id, name: f.name, type: "folder" })),
      ...files
        .filter((f) => f.path.length === currentPath.length && f.path.every((p, i) => p === currentPath[i]))
        .map((f) => ({ id: f.id, name: f.name, type: "file" })),
    ];
    // 변환/태그 모달의 대상 목록은 항상 ㄱㄴㄷ(가나다)순으로 보여준다.
    return items.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [currentPath, folders, files]);

  // 꾹 눌러 선택해 둔 항목이 있으면 그 항목들을 모달 목록에서 미리 체크한 채로 연다.
  const checkedFromSelection = (targets) =>
    Object.fromEntries(targets.filter((t) => selectedKeys[`${t.type}-${t.id}`]).map((t) => [t.id, true]));

  const openConvertModal = () => {
    setConvertChecked(checkedFromSelection(convertTargets));
    setConvertDrafts({});
    setConvertInput("");
    setConvertModalOpen(true);
    requestAnimationFrame(() => setConvertModalVisible(true));
  };
  const closeConvertModal = () => {
    setConvertModalVisible(false);
    setTimeout(() => setConvertModalOpen(false), 200);
  };
  const toggleConvertChecked = (id) => {
    setConvertChecked((prev) => ({ ...prev, [id]: !prev[id] }));
  };
  // 전체 선택 - 이미 전부 체크돼 있으면 전체 해제, 아니면 전체 선택으로 토글한다.
  const toggleConvertSelectAll = () => {
    const allChecked = convertTargets.length > 0 && convertTargets.every((item) => convertChecked[item.id]);
    setConvertChecked(allChecked ? {} : Object.fromEntries(convertTargets.map((item) => [item.id, true])));
  };
  // 지우기 - 체크된 항목들의 미리보기 이름을 비운다.
  const handleConvertClear = () => {
    setConvertDrafts((prev) => {
      const next = { ...prev };
      convertTargets.forEach((item) => {
        if (convertChecked[item.id]) next[item.id] = "";
      });
      return next;
    });
  };
  // 추가 - 입력창에 쓴 문자/숫자를 체크된 항목들의 미리보기 이름 뒤에 이어붙인다.
  const handleConvertAppend = () => {
    if (!convertInput) return;
    setConvertDrafts((prev) => {
      const next = { ...prev };
      convertTargets.forEach((item) => {
        if (convertChecked[item.id]) {
          const current = prev[item.id] !== undefined ? prev[item.id] : item.name;
          next[item.id] = current + convertInput;
        }
      });
      return next;
    });
  };
  // 변환 - 실제로 적용한다. 지우기로 비워둔 채 적용하면(빈 이름) 원래 이름으로 되돌리지
  // 않고, 목록 위에서부터(convertTargets 순서) 1, 2, 3...으로 순번을 붙인다(예: 12개를
  // 지우고 그대로 적용하면 1~12로 일괄 번호가 매겨진다). 그 외에 이름이 겹치는 경우는
  // 기존처럼 뒤에 (1), (2)...를 붙여 구분한다.
  const handleConvertApply = () => {
    const checkedItems = convertTargets.filter((item) => convertChecked[item.id]);
    if (!checkedItems.length) {
      closeConvertModal();
      return;
    }
    const finalNames = checkedItems.map((item) => ({
      id: item.id,
      name: (convertDrafts[item.id] !== undefined ? convertDrafts[item.id] : item.name).trim(),
    }));
    let blankCounter = 0;
    const withBlanksNumbered = finalNames.map((f) => {
      if (f.name === "") {
        blankCounter += 1;
        return { id: f.id, name: String(blankCounter) };
      }
      return f;
    });
    const counts = {};
    withBlanksNumbered.forEach((f) => {
      counts[f.name] = (counts[f.name] || 0) + 1;
    });
    const seen = {};
    const resolved = withBlanksNumbered.map((f) => {
      if (counts[f.name] > 1) {
        seen[f.name] = (seen[f.name] || 0) + 1;
        return { id: f.id, name: `${f.name}(${seen[f.name]})` };
      }
      return f;
    });
    const nameById = Object.fromEntries(resolved.map((r) => [r.id, r.name]));
    const now = Date.now();
    const checkedFolders = checkedItems.filter((item) => item.type === "folder");
    const checkedFiles = checkedItems.filter((item) => item.type === "file");

    // 폴더 이름이 바뀌면 그 하위 폴더/파일들의 path도 같이 rebase해야 한다(단일 이름 바꾸기와 동일 로직).
    const folderRenames = checkedFolders
      .map((item) => {
        const folder = folders.find((f) => f.id === item.id);
        const newName = nameById[item.id];
        return folder && newName && folder.name !== newName ? { folder, newName } : null;
      })
      .filter(Boolean);

    if (checkedFolders.length) {
      setFolders((prev) => prev.map((f) => {
        if (!nameById[f.id] || !checkedFolders.some((c) => c.id === f.id)) return f;
        const newName = nameById[f.id];
        return { ...f, name: newName, path: [...f.path.slice(0, -1), newName], updatedAt: now };
      }));
    }
    folderRenames.forEach(({ folder, newName }) => {
      const oldPrefix = folder.path;
      const newPrefix = [...oldPrefix.slice(0, -1), newName];
      setFolders((prev) => prev.map((f) => (f.id !== folder.id && pathStartsWith(f.path, oldPrefix) ? { ...f, path: rebasePath(f.path, oldPrefix, newPrefix) } : f)));
      setFiles((prev) => prev.map((f) => (pathStartsWith(f.path, oldPrefix) ? { ...f, path: rebasePath(f.path, oldPrefix, newPrefix) } : f)));
    });

    if (checkedFiles.length) {
      setFiles((prev) => prev.map((f) => (nameById[f.id] && checkedFiles.some((c) => c.id === f.id) ? { ...f, name: nameById[f.id], updatedAt: now } : f)));
    }
    closeConvertModal();
  };

  // 태그 모달 - "마법사" 메뉴의 "태그"를 누르면 뜬다. 레이아웃/동작은 변환 모달과 동일하되
  // 이름 대신 각 항목의 태그 배열(item.tags)을 다룬다. 폴더/파일(이미지) 제목 아래에
  // "#태그" 형태로 여러 개 붙을 수 있다.
  const [tagModalOpen, setTagModalOpen] = useState(false);
  const [tagModalVisible, setTagModalVisible] = useState(false);
  const [tagChecked, setTagChecked] = useState({}); // { [id]: true }
  const [tagDrafts, setTagDrafts] = useState({}); // { [id]: 미리보기용 태그 배열 }
  const [tagInput, setTagInput] = useState("");
  // 태그가 달린 항목을 모아 보여주는 "분류" 화면에서 지금 보고 있는 태그(들). 빈 배열이면 닫힌 상태.
  // 태그 팔레트에서 하나를 클릭하면 [tag] 하나만, 마법사의 분류 모달에서 여러 개를 체크해
  // 확인을 누르면 여러 태그가 한꺼번에 들어온다(OR 조건 - 그 중 하나라도 달려있으면 보임).
  const [tagScreenTags, setTagScreenTags] = useState([]);

  // 화면이 바뀌면(다른 폴더로 이동/검색어 변경/분류 화면 전환) 선택은 초기화한다 - 지금
  // 보이지도 않는 항목이 선택된 채로 남아 있으면 다운로드/변환 대상이 헷갈린다.
  useEffect(() => {
    setSelectedKeys({});
  }, [currentPath, tagScreenTags, searchQuery]);

  const tagTargets = useMemo(() => convertTargets.map((t) => {
    const source = t.type === "folder" ? folders.find((f) => f.id === t.id) : files.find((f) => f.id === t.id);
    return { ...t, tags: (source && source.tags) || [] };
  }), [convertTargets, folders, files]);

  const openTagModal = () => {
    setTagChecked(checkedFromSelection(tagTargets));
    setTagDrafts(Object.fromEntries(tagTargets.map((t) => [t.id, t.tags])));
    setTagInput("");
    setTagModalOpen(true);
    requestAnimationFrame(() => setTagModalVisible(true));
  };
  const closeTagModal = () => {
    setTagModalVisible(false);
    setTimeout(() => setTagModalOpen(false), 200);
  };
  const toggleTagChecked = (id) => {
    setTagChecked((prev) => ({ ...prev, [id]: !prev[id] }));
  };
  // 전체 선택 - 이미 전부 체크돼 있으면 전체 해제, 아니면 전체 선택으로 토글한다.
  const toggleTagSelectAll = () => {
    const allChecked = tagTargets.length > 0 && tagTargets.every((item) => tagChecked[item.id]);
    setTagChecked(allChecked ? {} : Object.fromEntries(tagTargets.map((item) => [item.id, true])));
  };
  // 삭제 - 체크된 항목들의 기존 보유 태그를 전부 비운다.
  const handleTagClear = () => {
    setTagDrafts((prev) => {
      const next = { ...prev };
      tagTargets.forEach((item) => {
        if (tagChecked[item.id]) next[item.id] = [];
      });
      return next;
    });
  };
  // 추가 - 입력창의 문자를 "#태그" 형태로 만들어 체크된 항목들에 새로 추가한다(중복 태그는 무시).
  const handleTagAppend = () => {
    const raw = tagInput.trim();
    if (!raw) return;
    const tag = raw.startsWith("#") ? raw : `#${raw}`;
    setTagDrafts((prev) => {
      const next = { ...prev };
      tagTargets.forEach((item) => {
        if (tagChecked[item.id]) {
          const current = prev[item.id] !== undefined ? prev[item.id] : item.tags;
          if (!current.includes(tag)) next[item.id] = [...current, tag];
        }
      });
      return next;
    });
    setTagInput("");
  };
  // 적용 - 실제로 folders/files에 태그 배열을 반영한다.
  const handleTagApply = () => {
    const checkedItems = tagTargets.filter((item) => tagChecked[item.id]);
    if (!checkedItems.length) {
      closeTagModal();
      return;
    }
    const now = Date.now();
    const tagsById = {};
    checkedItems.forEach((item) => {
      tagsById[item.id] = tagDrafts[item.id] !== undefined ? tagDrafts[item.id] : item.tags;
    });
    const checkedFolderIds = checkedItems.filter((i) => i.type === "folder").map((i) => i.id);
    const checkedFileIds = checkedItems.filter((i) => i.type === "file").map((i) => i.id);
    if (checkedFolderIds.length) setFolders((prev) => prev.map((f) => (checkedFolderIds.includes(f.id) ? { ...f, tags: tagsById[f.id], updatedAt: now } : f)));
    if (checkedFileIds.length) setFiles((prev) => prev.map((f) => (checkedFileIds.includes(f.id) ? { ...f, tags: tagsById[f.id], updatedAt: now } : f)));
    closeTagModal();
  };

  // "분류" 화면(구 태그 화면)에서 보여줄, 선택된 태그들 중 하나라도 달린 폴더/이미지/문서를
  // 종류별로 나눈 목록. 폴더가 항상 맨 위에 리스트로, 그 아래에 이미지/움짤이 갤러리(메이슨리)로 온다.
  const taggedFolders = tagScreenTags.length ? folders.filter((f) => (f.tags || []).some((t) => tagScreenTags.includes(t))) : [];
  const taggedFiles = tagScreenTags.length ? files.filter((f) => (f.tags || []).some((t) => tagScreenTags.includes(t))) : [];
  const taggedImages = taggedFiles.filter((f) => f.kind === "image");
  // 이미지가 아닌 파일은 모두 문서 행으로 보여준다("doc"/"text" 외의 kind를 가진(레거시 등) 파일이
  // 조용히 목록에서 누락되는 일이 없도록 - 변환/태그 모달의 대상 목록과 항상 일치해야 한다).
  const taggedDocs = taggedFiles.filter((f) => f.kind !== "image");
  const closeTagScreen = () => setTagScreenTags([]);

  // 태그 텍스트를 누르면 검색/팔레트를 거치지 않고 곧바로 그 태그의 "분류" 화면을 연다.
  const openTagScreen = (tag) => {
    setTagScreenTags([tag]);
  };

  // 이미지/움짤 전체화면 뷰어 - 열 당시의 이미지 배열을 그대로 들고 있다가
  // 좌우 스와이프(포인터 드래그)로 이전/다음 사진을 넘긴다. 드래그 중엔 손가락을 그대로
  // 따라가고, 손을 떼면 완전히 밀려나가며 다음/이전 사진이 반대편에서 슬라이드로 들어온다.
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerImages, setViewerImages] = useState([]);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerDragX, setViewerDragX] = useState(0);
  const [viewerAnimating, setViewerAnimating] = useState(false);
  const viewerDragRef = useRef(null);

  const openViewer = (images, index) => {
    setViewerImages(images);
    setViewerIndex(index);
    setViewerDragX(0);
    setViewerAnimating(false);
    setViewerOpen(true);
    requestAnimationFrame(() => setViewerVisible(true));
  };
  const closeViewer = () => {
    setViewerVisible(false);
    setTimeout(() => {
      setViewerOpen(false);
      setViewerImages([]);
    }, 200);
  };
  const viewerPointerDown = (e) => {
    viewerDragRef.current = { x: e.clientX };
    setViewerAnimating(false);
  };
  const viewerPointerMove = (e) => {
    if (!viewerDragRef.current) return;
    setViewerDragX(e.clientX - viewerDragRef.current.x);
  };
  // 배경(오버레이) 위에서 mousedown+mouseup은 드래그로 스와이프했더라도 같은 엘리먼트에서
  // 끝나면 브라우저가 click 이벤트도 함께 발생시키므로, onClick으로 따로 닫지 않고
  // 여기서 이동 거리를 직접 재서 살짝 누르면 닫고(탭) 충분히 끌면 넘긴다(스와이프).
  const viewerPointerUp = (e) => {
    if (!viewerDragRef.current) return;
    const dx = e.clientX - viewerDragRef.current.x;
    viewerDragRef.current = null;
    if (Math.abs(dx) < 10) {
      closeViewer();
      return;
    }
    const dir = dx < 0 ? 1 : -1; // 1 = 다음, -1 = 이전
    const canMove = dir === 1 ? viewerIndex < viewerImages.length - 1 : viewerIndex > 0;
    if (Math.abs(dx) >= 50 && canMove) {
      const vw = typeof window !== "undefined" ? window.innerWidth : 400;
      setViewerAnimating(true);
      setViewerDragX(-dir * vw); // 현재 사진을 스와이프 방향으로 완전히 밀어낸다
      setTimeout(() => {
        setViewerAnimating(false);
        setViewerIndex((i) => i + dir);
        setViewerDragX(dir * vw); // 다음 사진을 반대편 바깥에 배치
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setViewerAnimating(true);
            setViewerDragX(0); // 제자리로 슬라이드
          });
        });
      }, 220);
    } else {
      setViewerAnimating(true);
      setViewerDragX(0); // 임계값 미달 - 원위치로 스냅백
    }
  };

  // 이동 모달 - 삼점 메뉴의 "이동"을 누르면 최상위 홈부터 폴더를 탐색하며
  // 옮길 위치를 고를 수 있다. 폴더 자기 자신이나 그 하위 폴더로는 옮길 수 없다.
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [moveModalVisible, setMoveModalVisible] = useState(false);
  const [moveTarget, setMoveTarget] = useState(null); // { type: 'folder' | 'file', id, name }
  const [moveBrowsePath, setMoveBrowsePath] = useState([]);

  const openMoveModal = (type, id, name) => {
    setMoveTarget({ type, id, name });
    setMoveBrowsePath([]);
    setMoveModalOpen(true);
    requestAnimationFrame(() => setMoveModalVisible(true));
  };
  const closeMoveModal = () => {
    setMoveModalVisible(false);
    setTimeout(() => {
      setMoveModalOpen(false);
      setMoveTarget(null);
      setMoveBrowsePath([]);
    }, 200);
  };

  const movingFolder = moveTarget && moveTarget.type === "folder" ? folders.find((f) => f.id === moveTarget.id) : null;
  const movingFile = moveTarget && moveTarget.type === "file" ? files.find((f) => f.id === moveTarget.id) : null;
  const isBlockedMoveFolder = (folder) => {
    if (!movingFolder) return false;
    if (folder.id === movingFolder.id) return true;
    return (
      folder.path.length >= movingFolder.path.length &&
      movingFolder.path.every((seg, i) => folder.path[i] === seg)
    );
  };
  // 이동 모달의 탐색 목록 - 홈부터 폴더를 타고 들어간다. 폴더/이미지/문서 모두 홈을
  // 포함해 어디로든 옮길 수 있다.
  const moveModalEntries = !moveModalOpen
    ? []
    : folders
        .filter(
          (f) =>
            f.path.length === moveBrowsePath.length + 1 &&
            f.path.slice(0, moveBrowsePath.length).every((p, i) => p === moveBrowsePath[i]) &&
            !isBlockedMoveFolder(f)
        )
        .map((f) => ({ id: f.id, name: f.name }));
  const canDropHere = true;

  const confirmMove = () => {
    if (!moveTarget || !canDropHere) {
      closeMoveModal();
      return;
    }
    if (moveTarget.type === "folder") {
      const folder = folders.find((f) => f.id === moveTarget.id);
      if (folder) {
        const oldPath = folder.path;
        const newPath = [...moveBrowsePath, folder.name];
        setFolders((prev) =>
          prev.map((f) => {
            if (f.id === folder.id) return { ...f, path: newPath };
            if (f.path.length > oldPath.length && oldPath.every((seg, i) => f.path[i] === seg)) {
              return { ...f, path: [...newPath, ...f.path.slice(oldPath.length)] };
            }
            return f;
          })
        );
        setFiles((prev) =>
          prev.map((file) => {
            if (file.path.length >= oldPath.length && oldPath.every((seg, i) => file.path[i] === seg)) {
              return { ...file, path: [...newPath, ...file.path.slice(oldPath.length)] };
            }
            return file;
          })
        );
      }
    } else {
      setFiles((prev) => prev.map((f) => (f.id === moveTarget.id ? { ...f, path: moveBrowsePath } : f)));
    }
    closeMoveModal();
  };

  // 실제 갤러리/파일 선택 다이얼로그(input[type=file])를 통해 고른 항목을 R2에 업로드하고
  // 성공한 것만 현재 위치(currentPath)에 추가한다. 지원 형식(JPG/JPEG/PNG/GIF/APNG/WEBP/TXT)만 받는다.
  // 동시에 최대 UPLOAD_CONCURRENCY개만 실제로 전송하고(진행), 나머지는 차례를 기다리며(대기),
  // 각 파일의 업로드 현황(진행/완료/대기)은 uploadQueue로 관리해 하단 우측 업로드 현황 패널에 보여준다.
  const UPLOAD_CONCURRENCY = 3;
  const [uploadQueue, setUploadQueue] = useState([]); // [{ qid, name, size, loaded, status: 'queued'|'uploading'|'done'|'error' }]
  const [uploadPanelClosed, setUploadPanelClosed] = useState(false);
  const formatMB = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

  // XMLHttpRequest만 업로드 진행률(upload.onprogress)을 제공한다 - fetch는 요청 바디 전송
  // 진행률을 알려주지 않는다.
  const putFileWithProgress = (url, file, onProgress) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("content-type", file.type);
      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable) onProgress(evt.loaded);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`업로드 실패 (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error("업로드 실패"));
      xhr.send(file);
    });

  // 이미지/움짤을 올리기 전에 설정 탭 "업로드" 카드의 "최적화" 스위치가 켜져 있으면
  // 해상도는 그대로 두고 파일 용량을 원본의 절반 수준으로 줄인다(원본 스위치면 이
  // 함수 자체를 호출하지 않는다). 캔버스는 GIF/APNG를 다시 그 형식으로 인코딩할 수
  // 없어서(브라우저 표준 API의 한계) PNG는 PNG로 유지하고 그 외(JPEG/GIF/APNG/WEBP)는
  // JPEG로 인코딩한다 - 최적화로 올린 움짤은 애니메이션 없는 정지 이미지가 된다.
  //   · JPEG로 인코딩되는 경우: Canvas API가 "이 용량으로 인코딩해줘"를 직접 지원하지
  //     않으므로, JPEG 압축 품질(quality)을 이진 탐색으로 여러 번 조절해 목표 용량
  //     (원본의 50%)에 가장 가깝게(그러면서 화질은 최대한 높게) 맞춘다.
  //   · PNG는 무손실이라 quality를 줘도 브라우저가 무시하므로 통하지 않는다 - 대신
  //     픽셀 수를 절반으로 줄여(가로/세로 각각 약 70.7% = sqrt(0.5)) 대략 용량을
  //     절반 수준으로 낮춘다.
  const UPLOAD_OPTIMIZE_TARGET_RATIO = 0.5;
  const canvasEncode = (img, w, h, outType, quality) =>
    new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("압축 실패"))), outType, quality);
    });

  const compressImageFile = (file) =>
    new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = async () => {
        try {
          const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
          const targetBytes = file.size * UPLOAD_OPTIMIZE_TARGET_RATIO;
          let blob;
          if (outType === "image/png") {
            const scale = Math.sqrt(UPLOAD_OPTIMIZE_TARGET_RATIO);
            const w = Math.max(1, Math.round(img.naturalWidth * scale));
            const h = Math.max(1, Math.round(img.naturalHeight * scale));
            blob = await canvasEncode(img, w, h, outType, undefined);
          } else {
            const w = img.naturalWidth;
            const h = img.naturalHeight;
            let lo = 0.05;
            let hi = 0.92;
            const hiBlob = await canvasEncode(img, w, h, outType, hi);
            if (hiBlob.size <= targetBytes) {
              blob = hiBlob;
            } else {
              const loBlob = await canvasEncode(img, w, h, outType, lo);
              blob = loBlob;
              if (loBlob.size <= targetBytes) {
                for (let i = 0; i < 6; i++) {
                  const mid = (lo + hi) / 2;
                  const midBlob = await canvasEncode(img, w, h, outType, mid);
                  if (midBlob.size <= targetBytes) {
                    blob = midBlob;
                    lo = mid;
                  } else {
                    hi = mid;
                  }
                }
              }
            }
          }
          URL.revokeObjectURL(objectUrl);
          resolve({ blob, outType });
        } catch (err) {
          URL.revokeObjectURL(objectUrl);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("이미지를 불러오지 못했습니다"));
      };
      img.src = objectUrl;
    });

  // 실제 업로드 실행 - entries: [{ file, kind, path }]. path는 이 파일이 놓일 폴더의
  // 전체 경로로, 지금 보고 있는 위치(currentPath)를 쓴다.
  const uploadEntries = async (entries) => {
    if (!entries.length) return;

    // 이 업로드로 저장 공간 한도를 넘기면 하나도 올리지 않고 안내만 띄운다.
    const incomingBytes = entries.reduce((s, x) => s + x.file.size, 0);
    if (usedStorageBytes + incomingBytes > STORAGE_MAX_BYTES) {
      showToast("저장공간이 부족합니다");
      return;
    }

    // 이 업로드 배치를 시작하는 시점의 스위치 값을 그대로 고정해서 쓴다 - 업로드 도중
    // 설정 탭에서 스위치를 바꿔도 이미 시작된 배치에는 영향을 주지 않고, 그 다음 배치
    // (또는 진행 중인 배치가 끝난 뒤 새로 시작하는 업로드)부터 새 값이 적용된다.
    const optimizeThisBatch = uploadOptimizeEnabled;

    const queueItems = entries.map(({ file, kind, path }) => ({
      qid: `${Date.now()}-${Math.random()}`,
      file,
      kind,
      path,
      name: file.name,
      size: file.size,
      loaded: 0,
      status: "queued",
    }));
    setUploadQueue(queueItems.map(({ file, kind, path, ...rest }) => rest));
    setUploadPanelClosed(false);

    const updateItem = (qid, patch) => {
      setUploadQueue((prev) => prev.map((it) => (it.qid === qid ? { ...it, ...patch } : it)));
    };

    let cursor = 0;
    const runNext = async () => {
      const idx = cursor++;
      if (idx >= queueItems.length) return;
      const { qid, file, kind, path, size } = queueItems[idx];
      updateItem(qid, { status: "uploading" });
      const id = Date.now() + Math.random();
      let accepted = null;
      try {
        let uploadBlob = file;
        let uploadType = file.type;
        let uploadSize = size;
        if (kind === "image" && optimizeThisBatch) {
          const { blob, outType } = await compressImageFile(file);
          uploadBlob = blob;
          uploadType = outType;
          uploadSize = blob.size;
          updateItem(qid, { size: uploadSize });
        }
        const { base, ext: origExt } = splitNameExt(file.name);
        const ext = uploadType === "image/png" ? "png" : uploadType === "image/jpeg" ? "jpg" : origExt;
        const r2Key = `${id}-${encodeURIComponent(file.name)}`;
        const { url: putUrl } = await r2Presign({ action: "put", key: r2Key, contentType: uploadType });
        await putFileWithProgress(putUrl, uploadBlob, (loaded) => updateItem(qid, { loaded }));
        let url = null;
        if (kind === "image") {
          const presigned = await r2Presign({ action: "get", key: r2Key });
          url = presigned.url;
        }
        const now = Date.now();
        accepted = { id, name: base, ext, size: uploadSize, mimeType: uploadType, kind, r2Key, url, path, createdAt: now, updatedAt: now };
        updateItem(qid, { status: "done", loaded: uploadSize });
      } catch (err) {
        console.error("파일 업로드 실패:", file.name, err);
        updateItem(qid, { status: "error" });
      }
      if (accepted) setFiles((prev) => [...prev, accepted]);
      await runNext();
    };

    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queueItems.length) }, runNext));
  };

  // "파일 업로드" - 지금 보고 있는 위치에 파일 하나하나를 그대로 올린다. mp4 등 동영상은
  // 아직 지원하지 않는 형식이라 걸러지는데, 예전엔 아무 안내 없이 조용히 사라져서
  // "업로드했는데 왜 안 올라가지"로 오인하기 쉬웠다 - 하나라도 걸러지면 안내를 띄운다.
  const handleFilesPicked = async (e) => {
    const selected = Array.from(e.target.files || []);
    e.target.value = "";
    const entries = selected
      .map((file) => ({ file, kind: getKindFromName(file.name), path: currentPath }))
      .filter((x) => x.kind); // 미지원 형식은 건너뛴다
    if (entries.length < selected.length) {
      showToast("이미지·움짤 형식만 업로드할 수 있습니다");
    }
    await uploadEntries(entries);
  };

  const deleteFile = (fileId) => {
    const target = files.find((f) => f.id === fileId);
    if (!target) { closeItemMenu(); return; }
    setTrash((prev) => [...prev, {
      id: Date.now(),
      type: "file",
      name: target.name,
      deletedAt: Date.now(),
      files: [target],
    }]);
    setFiles((prev) => prev.filter((f) => f.id !== fileId));
    closeItemMenu();
    showToast("데이터를 삭제했습니다");
  };

  // 휴지통 선택 - 변환/태그 모달과 동일한 체크박스 + "전체 선택" 토글 방식. 각 항목에
  // 체크박스가 있고, "전체 선택"은 이미 전부 체크돼 있으면 전체 해제, 아니면 전체 선택으로
  // 토글한다. 오른쪽의 삭제/복구 버튼은 체크된 항목들에 대해서만 동작한다.
  const [trashChecked, setTrashChecked] = useState({}); // { [trashId]: true }
  const toggleTrashChecked = (id) => {
    setTrashChecked((prev) => ({ ...prev, [id]: !prev[id] }));
  };
  const toggleTrashSelectAll = () => {
    const allChecked = trash.length > 0 && trash.every((entry) => trashChecked[entry.id]);
    setTrashChecked(allChecked ? {} : Object.fromEntries(trash.map((entry) => [entry.id, true])));
  };
  const restoreCheckedTrash = () => {
    const checkedEntries = trash.filter((entry) => trashChecked[entry.id]);
    if (!checkedEntries.length) return;
    checkedEntries.forEach((entry) => {
      // entry.vault는 Vault 계층이 있던 시절에 삭제된 휴지통 항목에만 남아있을 수 있는
      // 레거시 필드 - 지금은 Vault가 없으므로 복구 시 평범한 홈 바로 아래 폴더로 되돌린다.
      if (entry.vault) setFolders((prev) => [...prev, { ...entry.vault, path: [entry.vault.name] }]);
      const foldersToRestore = entry.folder ? [entry.folder, ...(entry.folders || [])] : (entry.folders || []);
      if (foldersToRestore.length) setFolders((prev) => [...prev, ...foldersToRestore]);
      if (entry.files && entry.files.length) setFiles((prev) => [...prev, ...entry.files]);
    });
    const checkedIds = new Set(checkedEntries.map((entry) => entry.id));
    setTrash((prev) => prev.filter((entry) => !checkedIds.has(entry.id)));
    setTrashChecked({});
    showToast("데이터를 복구했습니다");
  };
  const deleteCheckedTrash = () => {
    const checkedEntries = trash.filter((entry) => trashChecked[entry.id]);
    if (!checkedEntries.length) return;
    checkedEntries.forEach((entry) => {
      (entry.files || []).forEach((f) => {
        if (f.r2Key) r2Presign({ action: "delete", key: f.r2Key }).catch((e) => console.error("R2 삭제 실패:", e));
      });
    });
    const checkedIds = new Set(checkedEntries.map((entry) => entry.id));
    setTrash((prev) => prev.filter((entry) => !checkedIds.has(entry.id)));
    setTrashChecked({});
  };

  // 휴지통 복구 - 원래 있던 자리(folders/files)로 그대로 되돌려 놓는다.
  const restoreTrashItem = (trashId) => {
    const entry = trash.find((t) => t.id === trashId);
    if (!entry) return;
    if (entry.vault) setFolders((prev) => [...prev, { ...entry.vault, path: [entry.vault.name] }]);
    const foldersToRestore = entry.folder ? [entry.folder, ...(entry.folders || [])] : (entry.folders || []);
    if (foldersToRestore.length) setFolders((prev) => [...prev, ...foldersToRestore]);
    if (entry.files && entry.files.length) setFiles((prev) => [...prev, ...entry.files]);
    setTrash((prev) => prev.filter((t) => t.id !== trashId));
    showToast("데이터를 복구했습니다");
  };

  // 휴지통에서 영구 삭제 - 확인 절차 없이 바로 지워지고, R2에 있던 실제 파일도 함께 삭제한다.
  const permanentlyDeleteTrashItem = (trashId) => {
    const entry = trash.find((t) => t.id === trashId);
    if (!entry) return;
    (entry.files || []).forEach((f) => {
      if (f.r2Key) r2Presign({ action: "delete", key: f.r2Key }).catch((e) => console.error("R2 삭제 실패:", e));
    });
    setTrash((prev) => prev.filter((t) => t.id !== trashId));
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  };

  // ── 다운로드 ─────────────────────────────────────────────────────────────
  // 삼점 메뉴의 "다운로드". 파일 하나면 그 파일을 그대로 받고, 폴더면 그 안의 하위
  // 폴더/파일을 구조 그대로 담은 zip으로 받는다. 선택 모드에서는(꾹 눌러 선택해 둔 것이
  // 있으면) 어느 항목의 메뉴에서 눌렀든 선택한 폴더/데이터 전체를 구조에 맞게 한 번에 받는다.
  // 실제 바이트는 R2에 있으므로 presigned GET URL을 발급받아 브라우저가 직접 받아온다.
  // 진행 상황은 업로드와 똑같은 하단 우측 패널(대기/진행/완료/실패 + 받은 용량)로 보여준다.
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadQueue, setDownloadQueue] = useState([]); // [{ qid, name, size, loaded, status }]
  const [downloadPanelClosed, setDownloadPanelClosed] = useState(false);
  const updateDownloadItem = (qid, patch) =>
    setDownloadQueue((prev) => prev.map((it) => (it.qid === qid ? { ...it, ...patch } : it)));

  const triggerBrowserDownload = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  // 저장할 때 쓸 파일 이름 - 이름(name)에는 확장자를 담지 않으므로 ext를 다시 붙인다.
  const downloadFileName = (file) => (file.ext ? `${file.name}.${file.ext}` : file.name);

  // 받는 중에 진행률을 알려면 응답 본문을 스트림으로 읽어야 한다(업로드의 XHR onprogress에
  // 해당하는 역할). 스트림을 못 쓰는 환경에서는 그냥 통째로 받는다.
  const fetchFileBlob = async (file, onProgress) => {
    // 마크다운 문서 등 R2에 올리지 않고 내용을 그대로 저장하는 파일은 바로 blob으로 만든다.
    if (!file.r2Key) {
      if (typeof file.content === "string") {
        const blob = new Blob([file.content], { type: file.mimeType || "text/plain" });
        if (onProgress) onProgress(blob.size);
        return blob;
      }
      return null;
    }
    const { url } = await r2Presign({ action: "get", key: file.r2Key });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`R2 다운로드 실패 (${res.status})`);
    if (!onProgress || !res.body || typeof res.body.getReader !== "function") return await res.blob();
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded);
    }
    return new Blob(chunks, { type: res.headers.get("content-type") || "application/octet-stream" });
  };

  // zip 안에서 이름이 겹치지 않게 "이름(1).jpg" 식으로 번호를 붙인다.
  const uniqueZipPath = (used, path) => {
    if (!used.has(path)) {
      used.add(path);
      return path;
    }
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash + 1);
    const base = slash === -1 ? path : path.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    let n = 1;
    let candidate;
    do {
      candidate = `${dir}${stem}(${n})${ext}`;
      n += 1;
    } while (used.has(candidate));
    used.add(candidate);
    return candidate;
  };

  // 받을 파일 목록과 zip 안에서의 위치를 먼저 전부 확정한다 - 그래야 시작하자마자
  // 진행 패널에 "대기" 상태로 전체 목록을 보여줄 수 있다(업로드 패널과 동일한 흐름).
  // 빈 하위 폴더까지 zip에 만들어서 구조를 그대로 재현한다.
  const buildDownloadPlan = (targetFolders, targetFiles) => {
    const used = new Set();
    const entries = []; // { file, zipPath }
    const emptyDirs = [];
    targetFolders.forEach((folder) => {
      const root = folder.name;
      emptyDirs.push(root);
      folders
        .filter((f) => f.id !== folder.id && pathStartsWith(f.path, folder.path))
        .forEach((f) => emptyDirs.push(`${root}/${f.path.slice(folder.path.length).join("/")}`));
      files
        .filter((f) => pathStartsWith(f.path, folder.path))
        .forEach((file) => {
          const rel = file.path.slice(folder.path.length).join("/");
          entries.push({ file, zipPath: uniqueZipPath(used, `${root}/${rel ? `${rel}/` : ""}${downloadFileName(file)}`) });
        });
    });
    targetFiles.forEach((file) => {
      entries.push({ file, zipPath: uniqueZipPath(used, downloadFileName(file)) });
    });
    return { entries, emptyDirs };
  };

  // 실제 다운로드 실행 - targetFolders/targetFiles를 받아 파일 하나면 그대로, 여럿이면 zip으로.
  const runDownload = async (targetFolders, targetFiles, zipName) => {
    if (downloadBusy) return;
    if (!targetFolders.length && !targetFiles.length) {
      showToast("다운로드할 항목이 없습니다");
      return;
    }
    const { entries, emptyDirs } = buildDownloadPlan(targetFolders, targetFiles);
    const receivable = entries.filter((e) => e.file.r2Key || typeof e.file.content === "string");
    if (!receivable.length) {
      showToast("다운로드할 항목이 없습니다");
      return;
    }
    setDownloadBusy(true);
    // 새 다운로드를 시작하면 이전 목록은 지우고 패널을 다시 연다(업로드와 동일).
    const startedAt = Date.now();
    const queued = receivable.map((e, i) => ({
      qid: `${startedAt}-${i}`,
      name: downloadFileName(e.file),
      size: e.file.size || 0,
      loaded: 0,
      status: "queued",
    }));
    setDownloadQueue(queued);
    setDownloadPanelClosed(false);

    const blobs = [];
    let anyError = false;
    for (let i = 0; i < receivable.length; i++) {
      const { file, zipPath } = receivable[i];
      const qid = queued[i].qid;
      updateDownloadItem(qid, { status: "downloading" });
      try {
        const blob = await fetchFileBlob(file, (loaded) => updateDownloadItem(qid, { loaded }));
        if (!blob) throw new Error("파일 데이터가 없습니다");
        blobs.push({ zipPath, blob });
        updateDownloadItem(qid, { status: "done", loaded: blob.size, size: blob.size });
      } catch (e) {
        console.error("다운로드 실패:", e);
        anyError = true;
        updateDownloadItem(qid, { status: "error" });
      }
    }

    try {
      // 파일 딱 하나면 zip으로 감싸지 않고 원본 파일 그대로 받는다.
      if (!targetFolders.length && targetFiles.length === 1) {
        if (blobs.length) triggerBrowserDownload(blobs[0].blob, downloadFileName(targetFiles[0]));
      } else if (blobs.length || emptyDirs.length) {
        // zip은 용량이 큰 의존성이라 실제로 필요할 때만 불러온다(초기 로딩 속도 유지).
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        emptyDirs.forEach((dir) => zip.folder(dir));
        blobs.forEach(({ zipPath, blob }) => zip.file(zipPath, blob));
        const content = await zip.generateAsync({ type: "blob" });
        triggerBrowserDownload(content, zipName);
      }
    } catch (e) {
      console.error("압축 실패:", e);
      anyError = true;
      setDownloadQueue((prev) => prev.map((it) => (it.status === "done" ? { ...it, status: "error" } : it)));
    } finally {
      setDownloadBusy(false);
    }
    if (anyError) showToast("일부 항목을 받지 못했습니다");
  };

  // 삼점 메뉴의 "다운로드"에서 호출한다. 선택된 항목이 있으면 그 전체를, 없으면 이 항목만.
  const handleDownload = (type, id) => {
    if (selectionMode) {
      runDownload(selectedFolders, selectedFiles, "Vaulty.zip");
      return;
    }
    if (type === "folder") {
      const folder = folders.find((f) => f.id === id);
      if (folder) runDownload([folder], [], `${folder.name}.zip`);
      return;
    }
    const file = files.find((f) => f.id === id);
    if (file) runDownload([], [file], `${file.name}.zip`);
  };

  // 업로드/다운로드 현황 패널 공용 렌더러 - 두 작업이 같은 디자인/동작을 쓰도록
  // 마크업을 한 곳에 두고 제목과 목록만 갈아끼운다.
  const renderTransferPanel = (title, queue, closed, onClose) => {
    if (!queue.length || closed) return null;
    return (
      <div
        style={{
          width: 280,
          maxWidth: "calc(100vw - 48px)",
          borderRadius: 16,
          background: isLight ? "rgba(255,255,255,0.85)" : "rgba(30,29,28,0.9)",
          backdropFilter: "blur(20px) saturate(180%)",
          WebkitBackdropFilter: "blur(20px) saturate(180%)",
          border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
          boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 14px",
            borderBottom: `1px solid ${isLight ? "rgba(20,22,26,0.1)" : "rgba(255,255,255,0.1)"}`,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700, color: isLight ? "#14161A" : "#FFFFFF" }}>{title}</span>
          <button
            onClick={onClose}
            aria-label="닫기"
            style={{
              width: 22,
              height: 22,
              flexShrink: 0,
              border: "none",
              background: "transparent",
              color: isLight ? "rgba(20,22,26,0.55)" : "rgba(255,255,255,0.55)",
              cursor: "pointer",
              outline: "none",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.08)"}
            onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <div style={{ overflowY: "auto", maxHeight: 260, padding: "4px 0" }}>
          {queue.map((item) => (
            <div
              key={item.qid}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 14px",
                fontSize: 12.5,
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: 28,
                  fontWeight: 600,
                  color: item.status === "error"
                    ? "#ff6b6b"
                    : item.status === "done"
                      ? (isLight ? "#14161A" : "#FFFFFF")
                      : (isLight ? "rgba(20,22,26,0.5)" : "rgba(255,255,255,0.5)"),
                }}
              >
                {item.status === "queued" && "대기"}
                {(item.status === "uploading" || item.status === "downloading") && "진행"}
                {item.status === "done" && "완료"}
                {item.status === "error" && "실패"}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: isLight ? "#14161A" : "#FFFFFF",
                }}
              >
                {item.name}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 11.5,
                  color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)",
                }}
              >
                ({formatMB(item.loaded)}/{formatMB(item.size)})
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];
  const formatDate = (ts) => {
    if (!ts) return "-";
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}년 ${m}월 ${day}일 (${WEEKDAY_KO[d.getDay()]})`;
  };

  // 정보 모달 - 삼점 메뉴의 "정보"를 누르면 대형 모달로 이름/생성 일자/수정 일자/크기를
  // 보여준다. 폴더/파일(이미지 포함) 공용.
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [infoModalVisible, setInfoModalVisible] = useState(false);
  const [infoTarget, setInfoTarget] = useState(null); // { type: 'folder' | 'file', id }
  const infoModalRef = useRef(null); // 섬네일 모달 높이를 맞추기 위해 실제 렌더링 높이를 잰다.

  const openInfoModal = (type, id) => {
    setInfoTarget({ type, id });
    setInfoModalOpen(true);
    requestAnimationFrame(() => setInfoModalVisible(true));
  };
  const closeInfoModal = () => {
    setInfoModalVisible(false);
    setTimeout(() => {
      setInfoModalOpen(false);
      setInfoTarget(null);
    }, 200);
  };
  const infoItem = !infoTarget
    ? null
    : infoTarget.type === "folder"
    ? folders.find((f) => f.id === infoTarget.id)
    : files.find((f) => f.id === infoTarget.id);
  const infoItemSize =
    !infoTarget || !infoItem
      ? 0
      : infoTarget.type === "folder"
      ? files.filter((f) => pathStartsWith(f.path, infoItem.path)).reduce((s, f) => s + (f.size || 0), 0)
      : infoItem.size || 0;
  // 정보 모달의 "해상도" 행 - 이미지/움짤 파일일 때만 "크기" 바로 위에 "3820x5420" 형태로
  // 보여준다. 파일 메타데이터에 해상도를 저장해두지 않으므로, 모달을 열 때마다 이미지를
  // 실제로 한 번 불러와 naturalWidth/naturalHeight를 읽는다.
  const [infoImageDims, setInfoImageDims] = useState(null); // { w, h } | null
  useEffect(() => {
    setInfoImageDims(null);
    if (infoTarget?.type === "file" && infoItem?.kind === "image" && infoItem?.url) {
      const img = new Image();
      img.onload = () => setInfoImageDims({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => setInfoImageDims(null);
      img.src = infoItem.url;
    }
  }, [infoTarget?.id, infoTarget?.type, infoItem?.url, infoItem?.kind]);

  // 커버 선택 - 정보 모달의 "커버"를 누르면 그 폴더 바로 안의 이미지/움짤들을 작은
  // 그리드로 보여주고, 하나를 고르면 folder.coverFileId로 저장한다(갤러리형 보기에서
  // 그 폴더 카드의 썸네일로 쓰인다). 폴더 안에 이미지가 없으면 고를 것이 없다는 안내만 보여준다.
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  const [coverPickerVisible, setCoverPickerVisible] = useState(false);
  const [coverPickerFolderId, setCoverPickerFolderId] = useState(null);
  // 섬네일 모달의 크기(높이)를 지금 열려 있는 정보 모달과 똑같이 맞추기 위해,
  // 열 때 정보 모달의 실제 렌더링 높이를 재서 그대로 적용한다.
  const [coverPickerHeight, setCoverPickerHeight] = useState(null);
  const openCoverPicker = (folderId) => {
    setCoverPickerHeight(infoModalRef.current ? infoModalRef.current.offsetHeight : null);
    setCoverPickerFolderId(folderId);
    setCoverPickerOpen(true);
    requestAnimationFrame(() => setCoverPickerVisible(true));
  };
  const closeCoverPicker = () => {
    setCoverPickerVisible(false);
    setTimeout(() => {
      setCoverPickerOpen(false);
      setCoverPickerFolderId(null);
    }, 200);
  };
  const coverPickerFolder = coverPickerFolderId ? folders.find((f) => f.id === coverPickerFolderId) : null;
  const coverPickerImages = coverPickerFolder
    ? files.filter((f) => f.kind === "image" && f.path.length === coverPickerFolder.path.length && f.path.every((p, i) => p === coverPickerFolder.path[i]))
    : [];
  const setFolderCover = (folderId, fileId) => {
    setFolders((prev) => prev.map((f) => (f.id === folderId ? { ...f, coverFileId: f.coverFileId === fileId ? undefined : fileId, updatedAt: Date.now() } : f)));
    closeCoverPicker();
  };

  const getFileIcon = (mimeType) => {
    const color = isLight ? "#14161A" : "#FFFFFF";
    if (mimeType && mimeType.startsWith("image/")) {
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill={color}>
          <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm3 10 3.2-4 2.4 3 2-2.6L18 15H7z" />
        </svg>
      );
    }
    if (mimeType && mimeType.startsWith("video/")) {
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill={color}>
          <path d="M4 5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3.5l4-2.2v11.4l-4-2.2V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z" />
        </svg>
      );
    }
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
        <path d="M14 2v5h5" />
      </svg>
    );
  };

  // ── 마크다운 렌더링 ──────────────────────────────────────────────────────
  // 무거운 외부 라이브러리 없이 "새 문서"가 실제로 필요한 문법만(제목/굵게/기울임/
  // 취소선/인라인 코드/코드 블록/링크/목록/인용/구분선) 가볍게 지원한다. 편집 화면의
  // 실시간 미리보기와 읽기 화면 양쪽에서 이 함수 하나를 그대로 함께 쓴다.
  // 인라인 문법(굵게/기울임/취소선/코드/링크) - 가장 먼저 나오는 패턴을 찾아 그 앞은
  // 그대로 텍스트로 두고 나머지를 재귀적으로 처리한다. 이렇게 해야 **굵게 *기울임***처럼
  // 문법이 겹쳐도 깨지지 않는다.
  const renderInlineMarkdown = (text, keyPrefix) => {
    const patterns = [
      {
        re: /\[([^\]]+)\]\(([^)]+)\)/,
        render: (m, key) => (
          <a key={key} href={m[2]} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
            {renderInlineMarkdown(m[1], `${key}-c`)}
          </a>
        ),
      },
      { re: /\*\*([^*]+)\*\*/, render: (m, key) => <strong key={key}>{renderInlineMarkdown(m[1], `${key}-c`)}</strong> },
      { re: /~~([^~]+)~~/, render: (m, key) => <s key={key}>{renderInlineMarkdown(m[1], `${key}-c`)}</s> },
      {
        re: /`([^`]+)`/,
        render: (m, key) => (
          <code
            key={key}
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: "0.9em",
              padding: "2px 5px",
              borderRadius: 4,
              background: isLight ? "rgba(20,22,26,0.08)" : "rgba(255,255,255,0.12)",
            }}
          >
            {m[1]}
          </code>
        ),
      },
      { re: /\*([^*]+)\*/, render: (m, key) => <em key={key}>{renderInlineMarkdown(m[1], `${key}-c`)}</em> },
      { re: /_([^_]+)_/, render: (m, key) => <em key={key}>{renderInlineMarkdown(m[1], `${key}-c`)}</em> },
    ];
    const out = [];
    let rest = text;
    let idx = 0;
    while (rest.length) {
      let earliest = null;
      let earliestPattern = null;
      patterns.forEach((p) => {
        const m = rest.match(p.re);
        if (m && (earliest === null || m.index < earliest.index)) {
          earliest = m;
          earliestPattern = p;
        }
      });
      if (!earliest) {
        out.push(rest);
        break;
      }
      if (earliest.index > 0) out.push(rest.slice(0, earliest.index));
      out.push(earliestPattern.render(earliest, `${keyPrefix}-${idx++}`));
      rest = rest.slice(earliest.index + earliest[0].length);
    }
    return out;
  };

  // 블록 문법(제목/코드블록/구분선/인용/목록/문단) - 줄 단위로 훑어 블록으로 나눈 뒤
  // 각 블록을 리액트 엘리먼트로 그린다.
  const renderMarkdown = (text) => {
    const textColor = isLight ? "#14161A" : "#FFFFFF";
    const mutedColor = isLight ? "rgba(20,22,26,0.55)" : "rgba(255,255,255,0.6)";
    if (!text || !text.trim()) {
      return <div style={{ color: mutedColor, fontSize: 14 }}>내용이 없습니다</div>;
    }
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
    let listBuffer = null; // { ordered: bool, items: [] }
    const flushList = () => {
      if (listBuffer) {
        blocks.push(listBuffer);
        listBuffer = null;
      }
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (/^```/.test(line)) {
        flushList();
        const codeLines = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // 닫는 ``` 건너뛰기
        blocks.push({ type: "code", content: codeLines.join("\n") });
        continue;
      }

      if (/^(---|\*\*\*|___)\s*$/.test(line)) {
        flushList();
        blocks.push({ type: "hr" });
        i++;
        continue;
      }

      const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headerMatch) {
        flushList();
        blocks.push({ type: "heading", level: headerMatch[1].length, text: headerMatch[2] });
        i++;
        continue;
      }

      if (/^>\s?/.test(line)) {
        flushList();
        const quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        blocks.push({ type: "quote", text: quoteLines.join("\n") });
        continue;
      }

      const ulMatch = line.match(/^[-*+]\s+(.*)$/);
      if (ulMatch) {
        if (!listBuffer || listBuffer.ordered) {
          flushList();
          listBuffer = { ordered: false, items: [] };
        }
        listBuffer.items.push(ulMatch[1]);
        i++;
        continue;
      }

      const olMatch = line.match(/^\d+\.\s+(.*)$/);
      if (olMatch) {
        if (!listBuffer || !listBuffer.ordered) {
          flushList();
          listBuffer = { ordered: true, items: [] };
        }
        listBuffer.items.push(olMatch[1]);
        i++;
        continue;
      }

      flushList();

      if (line.trim() === "") {
        i++;
        continue;
      }

      const paraLines = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^```/.test(lines[i]) &&
        !/^(---|\*\*\*|___)\s*$/.test(lines[i]) &&
        !/^#{1,6}\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^[-*+]\s+/.test(lines[i]) &&
        !/^\d+\.\s+/.test(lines[i])
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "paragraph", text: paraLines.join("\n") });
    }
    flushList();

    const headingSizes = { 1: 24, 2: 20, 3: 18, 4: 16, 5: 15, 6: 14 };

    return (
      <>
        {blocks.map((block, bi) => {
          if (block.type === "heading") {
            return (
              <div
                key={bi}
                style={{ fontSize: headingSizes[block.level] || 15, fontWeight: 700, color: textColor, margin: "20px 0 10px 0", lineHeight: 1.35 }}
              >
                {renderInlineMarkdown(block.text, `h${bi}`)}
              </div>
            );
          }
          if (block.type === "hr") {
            return <div key={bi} style={{ height: 1, background: isLight ? "rgba(20,22,26,0.15)" : "rgba(255,255,255,0.15)", margin: "20px 0" }} />;
          }
          if (block.type === "code") {
            return (
              <pre
                key={bi}
                style={{
                  margin: "12px 0",
                  padding: "12px 14px",
                  borderRadius: 10,
                  background: isLight ? "rgba(20,22,26,0.05)" : "rgba(255,255,255,0.06)",
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.1)" : "rgba(255,255,255,0.1)"}`,
                  overflowX: "auto",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: textColor,
                }}
              >
                {block.content}
              </pre>
            );
          }
          if (block.type === "quote") {
            return (
              <div
                key={bi}
                style={{
                  margin: "12px 0",
                  padding: "2px 14px",
                  borderLeft: `3px solid ${isLight ? "rgba(20,22,26,0.25)" : "rgba(255,255,255,0.3)"}`,
                  color: mutedColor,
                  fontSize: 15,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                }}
              >
                {renderInlineMarkdown(block.text, `q${bi}`)}
              </div>
            );
          }
          if (block.items) {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={bi} style={{ margin: "10px 0", paddingLeft: 22, color: textColor, fontSize: 15, lineHeight: 1.7 }}>
                {block.items.map((item, ii) => (
                  <li key={ii}>{renderInlineMarkdown(item, `l${bi}-${ii}`)}</li>
                ))}
              </Tag>
            );
          }
          return (
            <p key={bi} style={{ margin: "0 0 12px 0", color: textColor, fontSize: 15, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
              {renderInlineMarkdown(block.text, `p${bi}`)}
            </p>
          );
        })}
      </>
    );
  };

  // 버튼을 누르는 순간 살짝 눌리는 듯한 촉감 애니메이션 - 손을 떼거나 커서가
  // 벗어나면 원래 스케일(래스팅 값)로 되돌아온다.
  const pressDown = (restingTransform) => (e) => {
    e.currentTarget.style.transform = "scale(0.92)";
  };
  const pressUp = (restingTransform) => (e) => {
    e.currentTarget.style.transform = restingTransform;
  };

  // 상단 헤더(제목) 스티키 공통 스타일: 스크롤해도 화면 최상단에 계속 고정되어 보이고,
  // 탭 콘텐츠의 좌우 패딩을 상쇄하는 음수 마진으로 배경을 화면 끝까지 채운다.
  // minHeight를 우측 버튼 크기(TOP_BUTTON_SIZE)로 고정해둔다 - 안 그러면 그 자리에 버튼이
  // 뜨는 탭(홈의 +)과 안 뜨는 탭(설정/커뮤니티)의 헤더 높이가 달라져서 구분선/본문 시작
  // 위치가 탭마다 어긋나 보인다.
  const stickyHeaderStyle = {
    position: "sticky",
    top: 0,
    zIndex: 5,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: TOP_BUTTON_SIZE,
    margin: "0 -20px 24px -20px",
    // 우측 원형 버튼(추가/닫기)이 화면 우측 끝에 너무 딱 붙지 않으면서도 여백이 과하지
    // 않도록, 좌측(제목)보다 살짝 좁힌 값을 오른쪽 패딩으로 쓴다.
    padding: "22px 16px 14px 20px",
    background: isLight ? "rgba(255,255,255,0.45)" : "rgba(20,20,19,0.45)",
    backdropFilter: "blur(20px) saturate(180%)",
    WebkitBackdropFilter: "blur(20px) saturate(180%)",
  };

  return (
    <div
      style={{
        minHeight: vh,
        width: "100%",
        position: "relative",
        zIndex: 0,
        fontFamily:
          "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      {/* 문서 전체 여백 제거 및 배경색 강제 적용 */}
      <style>{`
        html, body, #root {
          margin: 0;
          padding: 0;
          min-height: 100%;
          background: ${isLight ? "#FAF9F5" : "#141413"};
        }
        @keyframes vaulty-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>

      {/* 전체 화면을 항상 덮는 고정 배경 레이어 */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background:
            theme === "sunset" || theme === "forest"
              ? THEME_SWATCHES[theme]
              : THEME_SWATCHES[isLight ? "light" : "dark"],
          zIndex: -1,
          transition: "background 0.3s ease",
        }}
      />

      {/* 탭 콘텐츠 영역 - 데스크탑 등 넓은 화면에서는 CONTENT_MAX_WIDTH에서 잘라 가운데
          정렬한다(뒤의 고정 배경 레이어는 계속 화면 전체를 채운다). */}
      <div
        style={{
          minHeight: vh,
          width: "100%",
          maxWidth: CONTENT_MAX_WIDTH,
          margin: "0 auto",
          boxSizing: "border-box",
          padding: "0 20px 140px 20px",
        }}
      >
        {/* 상단 헤더 - "분류" 화면일 때만 제목("분류") + 닫기(X)를 보여주고, 그 외에는
            좌측에 "Vaulty" 제목, 중앙에 검색창(가운데 남는 공간의 2/3 폭), 우측에
            사람 아이콘 버튼(설정 화면 열기)을 둔다. 예전 + 버튼(업로드 메뉴 트리거)은
            "마법사" 옆 "업로드" 버튼으로 옮겨갔다. */}
        <div style={stickyHeaderStyle}>
          {tagScreenTags.length ? (
            <>
              <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: isLight ? "#14161A" : "#FFFFFF", letterSpacing: 0.2, minHeight: "1em" }}>
                분류
              </h1>
              <div style={{ position: "relative" }}>
                <button
                  onClick={closeTagScreen}
                  onMouseEnter={() => setTrashCloseButtonHovered(true)}
                  onMouseLeave={(e) => {
                    setTrashCloseButtonHovered(false);
                    e.currentTarget.style.transform = "scale(1)";
                  }}
                  onMouseDown={pressDown("scale(0.9)")}
                  onMouseUp={pressUp(trashCloseButtonHovered ? "scale(1.08)" : "scale(1)")}
                  onTouchStart={pressDown("scale(0.9)")}
                  onTouchEnd={pressUp("scale(1)")}
                  style={{
                    width: TOP_BUTTON_SIZE,
                    height: TOP_BUTTON_SIZE,
                    flexShrink: 0,
                    borderRadius: "50%",
                    border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                    background: trashCloseButtonHovered
                      ? (isLight ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.14)")
                      : (isLight ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.06)"),
                    backdropFilter: "blur(20px) saturate(180%)",
                    WebkitBackdropFilter: "blur(20px) saturate(180%)",
                    boxShadow: trashCloseButtonHovered
                      ? "0 10px 36px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.3)"
                      : "0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    color: isLight ? "#14161A" : "#FFFFFF",
                    outline: "none",
                    transition: "background 0.3s ease, box-shadow 0.3s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
                    transform: trashCloseButtonHovered ? "scale(1.08)" : "scale(1)",
                  }}
                  aria-label="닫기"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="6" x2="18" y2="18" />
                    <line x1="18" y1="6" x2="6" y2="18" />
                  </svg>
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Vaulty 제목 - 검색 중이면 검색어를 지우면서 홈으로 돌아간다. */}
              <h1
                onClick={() => {
                  setSearchQuery("");
                  setCurrentPath([]);
                }}
                style={{
                  margin: 0,
                  height: TOP_BUTTON_SIZE,
                  display: "flex",
                  alignItems: "center",
                  fontSize: 26,
                  fontWeight: 700,
                  color: isLight ? "#14161A" : "#FFFFFF",
                  letterSpacing: 0.2,
                  flexShrink: 0,
                  cursor: "pointer",
                }}
              >
                Vaulty
              </h1>
              <div style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "center", padding: "0 12px" }}>
                <div style={{ position: "relative", width: "85.8%" }}>
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    aria-label="검색"
                    style={{
                      width: "100%",
                      height: TOP_BUTTON_SIZE,
                      boxSizing: "border-box",
                      padding: "0 40px 0 18px",
                      borderRadius: TOP_BUTTON_SIZE / 2,
                      border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                      background: isLight ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.06)",
                      backdropFilter: "blur(20px) saturate(180%)",
                      WebkitBackdropFilter: "blur(20px) saturate(180%)",
                      color: isLight ? "#14161A" : "#FFFFFF",
                      fontSize: 15,
                      fontWeight: 500,
                      outline: "none",
                      textAlign: "center",
                    }}
                  />
                  {/* 검색 아이콘 - 실제 동작은 없고, 이 인풋이 검색창임을 알려주는 용도로만 오른쪽 끝에 둔다. */}
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.5)"}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
                  >
                    <circle cx="11" cy="11" r="7" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </div>
              </div>
              <div style={{ position: "relative" }}>
                <button
                  onClick={() => setSettingsScreenOpen(true)}
                  onMouseEnter={() => setSettingsButtonHovered(true)}
                  onMouseLeave={(e) => {
                    setSettingsButtonHovered(false);
                    e.currentTarget.style.transform = "scale(1)";
                  }}
                  onMouseDown={pressDown("scale(0.9)")}
                  onMouseUp={pressUp(settingsButtonHovered ? "scale(1.08)" : "scale(1)")}
                  onTouchStart={pressDown("scale(0.9)")}
                  onTouchEnd={pressUp("scale(1)")}
                  aria-label="설정"
                  style={{
                    width: TOP_BUTTON_SIZE,
                    height: TOP_BUTTON_SIZE,
                    flexShrink: 0,
                    borderRadius: "50%",
                    border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                    background: settingsButtonHovered
                      ? (isLight ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.14)")
                      : (isLight ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.06)"),
                    backdropFilter: "blur(20px) saturate(180%)",
                    WebkitBackdropFilter: "blur(20px) saturate(180%)",
                    boxShadow: settingsButtonHovered
                      ? "0 10px 36px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.3)"
                      : "0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    color: isLight ? "#14161A" : "#FFFFFF",
                    outline: "none",
                    transition: "background 0.3s ease, box-shadow 0.3s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
                    transform: settingsButtonHovered ? "scale(1.08)" : "scale(1)",
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 21a8 8 0 0 1 16 0z" />
                  </svg>
                </button>
              </div>
            </>
          )}
        </div>

        {/* 로그인 게이트 - 웹드라이브(폴더/파일)는 로그인 계정 전용 데이터라
            로그인하지 않은 상태에서는 홈 탭 콘텐츠 전체 대신 안내만 보여준다.
            로딩이 끝나기 전(authLoading)에는 깜빡임을 피하려 아무것도 보여주지 않는다. */}
        {!authLoading && !authUser && (
          <div
            style={{
              padding: "64px 0",
              textAlign: "center",
              color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)",
              fontSize: 14,
            }}
          >
            로그인이 필요합니다
            <div style={{ marginTop: 6, fontSize: 12, color: isLight ? "rgba(20,22,26,0.32)" : "rgba(255,255,255,0.42)" }}>
              설정에서 로그인해주세요
            </div>
          </div>
        )}

        {/* 홈 탭 콘텐츠 - tagScreenTags가 설정돼 있으면(태그 팔레트/분류 모달에서 고른 상태) 아래
            IIFE 안에서 "분류" 화면을 최우선으로 렌더링한다(renderRow 등을 그대로 재사용하기
            위해 이 블록 안에 둔다). 텍스트 에디터가 열려 있는 동안은 전체화면 오버레이에
            완전히 가려지는 데다, 매 타이핑마다 이 무거운 목록 전체가 다시 계산/렌더되면서
            입력이 밀리는 원인이 되므로 아예 렌더링을 건너뛴다. */}
        {authUser && (
          <>
            {/* 경로 표기 및 정렬/보기 방식 아이콘 영역 - "분류" 화면에서는 마법사 버튼,
                경로 표시 텍스트, 구분선 없이 곧바로 목록만 보여준다. */}
            {!tagScreenTags.length && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingBottom: 12,
                marginBottom: 16,
                borderBottom: `1px solid ${isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)"}`,
              }}
            >
              {/* 경로 표기 - "홈"은 검색 중이면 검색어만 지워서(위치는 그대로) 보고 있던
                  화면으로 돌아가고, 검색 중이 아니면 평소처럼 홈으로 이동한다. 표기 항목이
                  (홈 포함) 3개를 넘어가면 - 즉 홈>A>B>C처럼 깊어지면 - 첫 줄엔 홈,A,B까지만
                  두고 C부터는 다음 줄로 내려서 표기한다(그 이상 깊어지면 flexWrap으로 계속
                  줄바꿈). */}
              <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button
                    onClick={() => {
                      if (searchQuery) {
                        setSearchQuery("");
                        return;
                      }
                      setCurrentPath([]);
                    }}
                    onMouseDown={pressDown("scale(0.92)")}
                    onMouseUp={pressUp("scale(1)")}
                    style={{
                      background: "none",
                      border: "none",
                      color: isLight ? "#14161A" : "#FFFFFF",
                      fontSize: 15,
                      fontWeight: 500,
                      cursor: "pointer",
                      padding: 0,
                      outline: "none",
                      opacity: currentPath.length === 0 ? 1 : 0.7,
                      transition: "opacity 0.2s ease, transform 0.15s ease",
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.opacity = "1"}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.opacity = currentPath.length === 0 ? "1" : "0.7";
                      e.currentTarget.style.transform = "scale(1)";
                    }}
                  >
                    홈
                  </button>
                  {currentPath.slice(0, 2).map((path, index) => (
                    <div key={index} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)", fontSize: 15 }}>
                        &gt;
                      </span>
                      <button
                        onClick={() => navigateToBreadcrumb(index)}
                        onMouseDown={pressDown("scale(0.92)")}
                        onMouseUp={pressUp("scale(1)")}
                        style={{
                          background: "none",
                          border: "none",
                          color: isLight ? "#14161A" : "#FFFFFF",
                          fontSize: 15,
                          fontWeight: 500,
                          cursor: "pointer",
                          padding: 0,
                          outline: "none",
                          opacity: 0.7,
                          transition: "opacity 0.2s ease, transform 0.15s ease",
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.opacity = "1"}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.opacity = "0.7";
                          e.currentTarget.style.transform = "scale(1)";
                        }}
                      >
                        {path}
                      </button>
                    </div>
                  ))}
                </div>
                {currentPath.length > 2 && (
                  <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
                    {currentPath.slice(2).map((path, i) => {
                      const index = i + 2;
                      return (
                        <div key={index} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)", fontSize: 15 }}>
                            &gt;
                          </span>
                          <button
                            onClick={() => navigateToBreadcrumb(index)}
                            onMouseDown={pressDown("scale(0.92)")}
                            onMouseUp={pressUp("scale(1)")}
                            style={{
                              background: "none",
                              border: "none",
                              color: isLight ? "#14161A" : "#FFFFFF",
                              fontSize: 15,
                              fontWeight: 500,
                              cursor: "pointer",
                              padding: 0,
                              outline: "none",
                              opacity: 0.7,
                              transition: "opacity 0.2s ease, transform 0.15s ease",
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.opacity = "1"}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.opacity = "0.7";
                              e.currentTarget.style.transform = "scale(1)";
                            }}
                          >
                            {path}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 마법사 - 예전 ABC 정렬 버튼 자리. 누르면 "정렬"/"변환" 드롭다운이 뜬다 */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {/* 선택 중일 때만 - 몇 개를 선택했는지와 한 번에 전부 해제하는 버튼 */}
                {selectionMode && (
                  <button
                    onClick={clearSelection}
                    onMouseDown={pressDown("scale(0.95)")}
                    onMouseUp={pressUp("scale(1)")}
                    style={{
                      height: 30,
                      padding: "0 10px",
                      borderRadius: 8,
                      border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                      background: "transparent",
                      color: isLight ? "rgba(20,22,26,0.6)" : "rgba(255,255,255,0.65)",
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: "pointer",
                      outline: "none",
                      whiteSpace: "nowrap",
                      transition: "background 0.2s ease, transform 0.15s ease",
                    }}
                  >
                    {selectionCount}개 선택 해제
                  </button>
                )}
                <button
                  ref={wizardButtonRef}
                  onClick={toggleWizardMenu}
                  onMouseDown={pressDown("scale(0.9)")}
                  onMouseUp={pressUp("scale(1)")}
                  aria-label="마법사"
                  title="마법사"
                  style={{
                    minWidth: 36,
                    height: 30,
                    padding: "0 10px",
                    borderRadius: 8,
                    border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                    background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                    color: isLight ? "#14161A" : "#FFFFFF",
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: 0.2,
                    cursor: "pointer",
                    outline: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "background 0.2s ease, transform 0.15s ease",
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.12)"}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)";
                    e.currentTarget.style.transform = "scale(1)";
                  }}
                >
                  마법사
                </button>

                {wizardMenuOpen && createPortal(
                  <>
                    <div onClick={closeWizardMenu} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 19 }} />
                    <div
                      style={{
                        position: "fixed",
                        top: wizardMenuAnchor.top,
                        right: wizardMenuAnchor.right,
                        minWidth: 140,
                        background: isLight ? "rgba(255,255,255,0.95)" : "rgba(20,20,19,0.95)",
                        backdropFilter: "blur(20px) saturate(180%)",
                        WebkitBackdropFilter: "blur(20px) saturate(180%)",
                        borderRadius: 12,
                        border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                        boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
                        zIndex: 20,
                        overflow: "hidden",
                        transformOrigin: "top right",
                        opacity: wizardMenuVisible ? 1 : 0,
                        transform: wizardMenuVisible ? "scale(1) translateY(0)" : "scale(0.92) translateY(-6px)",
                        transition: "opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1), transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => {
                          closeWizardMenu();
                          cycleSortMode();
                        }}
                        onMouseDown={pressDown("scale(0.97)")}
                        onMouseUp={pressUp("scale(1)")}
                        style={{
                          width: "100%",
                          padding: "10px 12px",
                          border: "none",
                          background: "transparent",
                          color: isLight ? "#14161A" : "#FFFFFF",
                          fontSize: 15,
                          fontWeight: 500,
                          cursor: "pointer",
                          outline: "none",
                          textAlign: "left",
                          transition: "background 0.2s, transform 0.15s ease",
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)"}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.transform = "scale(1)"; }}
                      >
                        정렬
                      </button>
                      <div style={{ height: 1, background: isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)" }} />
                      <button
                        onClick={() => {
                          closeWizardMenu();
                          toggleGalleryMode();
                        }}
                        onMouseDown={pressDown("scale(0.97)")}
                        onMouseUp={pressUp("scale(1)")}
                        style={{
                          width: "100%",
                          padding: "10px 12px",
                          border: "none",
                          background: "transparent",
                          color: isLight ? "#14161A" : "#FFFFFF",
                          fontSize: 15,
                          fontWeight: 500,
                          cursor: "pointer",
                          outline: "none",
                          textAlign: "left",
                          transition: "background 0.2s, transform 0.15s ease",
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)"}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.transform = "scale(1)"; }}
                      >
                        보기
                      </button>
                      <div style={{ height: 1, background: isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)" }} />
                      <button
                        onClick={() => {
                          closeWizardMenu();
                          openConvertModal();
                        }}
                        onMouseDown={pressDown("scale(0.97)")}
                        onMouseUp={pressUp("scale(1)")}
                        style={{
                          width: "100%",
                          padding: "10px 12px",
                          border: "none",
                          background: "transparent",
                          color: isLight ? "#14161A" : "#FFFFFF",
                          fontSize: 15,
                          fontWeight: 500,
                          cursor: "pointer",
                          outline: "none",
                          textAlign: "left",
                          transition: "background 0.2s, transform 0.15s ease",
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)"}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.transform = "scale(1)"; }}
                      >
                        변환
                      </button>
                      <div style={{ height: 1, background: isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)" }} />
                      <button
                        onClick={() => {
                          closeWizardMenu();
                          openTagModal();
                        }}
                        onMouseDown={pressDown("scale(0.97)")}
                        onMouseUp={pressUp("scale(1)")}
                        style={{
                          width: "100%",
                          padding: "10px 12px",
                          border: "none",
                          background: "transparent",
                          color: isLight ? "#14161A" : "#FFFFFF",
                          fontSize: 15,
                          fontWeight: 500,
                          cursor: "pointer",
                          outline: "none",
                          textAlign: "left",
                          transition: "background 0.2s, transform 0.15s ease",
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)"}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.transform = "scale(1)"; }}
                      >
                        태그
                      </button>
                    </div>
                  </>,
                  document.body
                )}

                {/* 업로드 - 예전엔 상단 헤더 우측의 + 버튼이었는데, 그 자리를 설정(⚙) 버튼에
                    내주면서 마법사 버튼 옆으로 옮겨왔다. 홈을 포함해 어디서든 항상 업로드
                    메뉴(업로드/폴더)를 여는 동일한 동작이다. 다른 버튼들과 대비되도록
                    다크모드에서는 흰 배경, 라이트모드에서는 검은 배경을 쓴다. */}
                <button
                  ref={uploadButtonRef}
                  onClick={toggleUploadMenu}
                  onMouseDown={pressDown("scale(0.9)")}
                  onMouseUp={pressUp("scale(1)")}
                  aria-label="업로드"
                  title="업로드"
                  style={{
                    minWidth: 36,
                    height: 30,
                    padding: "0 10px",
                    borderRadius: 8,
                    border: "none",
                    background: isLight ? "#14161A" : "#FFFFFF",
                    color: isLight ? "#FFFFFF" : "#14161A",
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: 0.2,
                    cursor: "pointer",
                    outline: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    transition: "transform 0.15s ease",
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.transform = "translateY(-1px)"}
                  onMouseLeave={(e) => e.currentTarget.style.transform = "translateY(0)"}
                >
                  {uploadQueue.some((it) => it.status === "queued" || it.status === "uploading") ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ animation: "vaulty-spin 0.8s linear infinite" }}>
                      <path d="M12 3a9 9 0 1 0 9 9" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  )}
                  업로드
                </button>

                {/* 숨겨진 파일 입력 - "파일 업로드": 이미지·움짤만 받는다. accept를 이미지로
                    좁혀 뒀기 때문에 모바일(iOS/Android)에서는 갤러리(사진 앱)가 열리고,
                    데스크탑에서는 그 형식으로 필터링된 일반 파일 탐색창이 열린다. */}
                <input
                  ref={galleryInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/apng,image/webp,.jpg,.jpeg,.png,.gif,.apng,.webp"
                  multiple
                  onChange={handleFilesPicked}
                  style={{ display: "none" }}
                />

                {/* 신규 메뉴 - 홈을 포함해 어디서든 신규 버튼을 누르면 뜬다.
                    파일(업로드) / 폴더(새로 만들기) / 문서(새로 만들기) 세 가지를 고를 수 있다. */}
                {uploadMenuOpen && createPortal(
                  <>
                    <div onClick={closeUploadMenu} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 19 }} />
                    <div
                      style={{
                        position: "fixed",
                        top: uploadMenuAnchor.top,
                        right: uploadMenuAnchor.right,
                        minWidth: 140,
                        background: isLight ? "rgba(255,255,255,0.95)" : "rgba(20,20,19,0.95)",
                        backdropFilter: "blur(20px) saturate(180%)",
                        WebkitBackdropFilter: "blur(20px) saturate(180%)",
                        borderRadius: 12,
                        border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                        boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
                        zIndex: 20,
                        overflow: "hidden",
                        transformOrigin: "top right",
                        opacity: uploadMenuVisible ? 1 : 0,
                        transform: uploadMenuVisible ? "scale(1) translateY(0)" : "scale(0.92) translateY(-6px)",
                        transition: "opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1), transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* 파일 - 업로드 기능(이미지/움짤 파일 선택). */}
                      <button
                        onClick={() => {
                          closeUploadMenu();
                          galleryInputRef.current && galleryInputRef.current.click();
                        }}
                        onMouseDown={pressDown("scale(0.97)")}
                        onMouseUp={pressUp("scale(1)")}
                        style={{
                          width: "100%",
                          padding: "10px 12px",
                          border: "none",
                          background: "transparent",
                          color: isLight ? "#14161A" : "#FFFFFF",
                          fontSize: 15,
                          fontWeight: 500,
                          cursor: "pointer",
                          outline: "none",
                          textAlign: "left",
                          transition: "background 0.2s, transform 0.15s ease",
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)"}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.transform = "scale(1)"; }}
                      >
                        파일
                      </button>
                      <div style={{ height: 1, background: isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)" }} />
                      <button
                        onClick={() => {
                          closeUploadMenu();
                          openFolderModal();
                        }}
                        onMouseDown={pressDown("scale(0.97)")}
                        onMouseUp={pressUp("scale(1)")}
                        style={{
                          width: "100%",
                          padding: "10px 12px",
                          border: "none",
                          background: "transparent",
                          color: isLight ? "#14161A" : "#FFFFFF",
                          fontSize: 15,
                          fontWeight: 500,
                          cursor: "pointer",
                          outline: "none",
                          textAlign: "left",
                          transition: "background 0.2s, transform 0.15s ease",
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)"}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.transform = "scale(1)"; }}
                      >
                        폴더
                      </button>
                      <div style={{ height: 1, background: isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)" }} />
                      {/* 문서 - 마크다운 문법을 쓸 수 있는 텍스트 문서(.md)를 지금 보고
                          있는 위치에 만들고, 만들자마자 바로 편집 화면을 연다. */}
                      <button
                        onClick={() => {
                          closeUploadMenu();
                          openDocCreateModal();
                        }}
                        onMouseDown={pressDown("scale(0.97)")}
                        onMouseUp={pressUp("scale(1)")}
                        style={{
                          width: "100%",
                          padding: "10px 12px",
                          border: "none",
                          background: "transparent",
                          color: isLight ? "#14161A" : "#FFFFFF",
                          fontSize: 15,
                          fontWeight: 500,
                          cursor: "pointer",
                          outline: "none",
                          textAlign: "left",
                          transition: "background 0.2s, transform 0.15s ease",
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)"}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.transform = "scale(1)"; }}
                      >
                        문서
                      </button>
                    </div>
                  </>,
                  document.body
                )}
              </div>
            </div>
            )}

            {/* 구분선 아래 드라이브 공간 - 홈을 포함해 어디서든 폴더(행) + 문서(행) +
                이미지(비율 콜라주)를 함께 보여준다. */}
            {(() => {
              // 삼점 메뉴(이름 수정/이동/삭제) - 폴더/파일 공용.
              // 버튼/래퍼 양쪽에서 stopPropagation 하고 5px 안전 여백을 둬서 근처를 눌러도
              // 항목이 열리지 않고 메뉴만 토글되도록 하며, backdropFilter 컨테이닝 블록 문제를
              // 피하기 위해 드롭다운은 document.body 로 포탈해 화면 좌표로 띄운다.
              const renderItemMenu = (type, item) => {
                const isOpen = itemMenuOpen && itemMenuOpen.type === type && itemMenuOpen.id === item.id;
                const isVisible = itemMenuVisibleKey === `${type}-${item.id}`;
                const onDelete = type === "folder" ? deleteFolder : deleteFile;
                return (
                  <div
                    style={{ position: "relative", margin: -5, padding: 5, flexShrink: 0 }}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onMouseUp={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                    onTouchEnd={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleItemMenu(type, item.id, e.currentTarget);
                      }}
                      onMouseDown={pressDown("scale(0.85)")}
                      onMouseUp={pressUp("scale(1)")}
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 7,
                        border: "none",
                        background: "transparent",
                        color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)",
                        cursor: "pointer",
                        outline: "none",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        transition: "all 0.2s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.08)";
                        e.currentTarget.style.color = isLight ? "#14161A" : "#FFFFFF";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.color = isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)";
                      }}
                      aria-label="옵션"
                    >
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="5" r="2" />
                        <circle cx="12" cy="12" r="2" />
                        <circle cx="12" cy="19" r="2" />
                      </svg>
                    </button>

                    {isOpen && createPortal(
                      <>
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            closeItemMenu();
                          }}
                          style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 29 }}
                        />
                        <div
                          style={{
                            position: "fixed",
                            top: itemMenuAnchor.top,
                            right: itemMenuAnchor.right,
                            width: 148,
                            background: isLight ? "rgba(255,255,255,0.95)" : "rgba(20,20,19,0.95)",
                            backdropFilter: "blur(20px) saturate(180%)",
                            WebkitBackdropFilter: "blur(20px) saturate(180%)",
                            borderRadius: 12,
                            border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                            boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
                            zIndex: 30,
                            overflow: "hidden",
                            transformOrigin: "top right",
                            opacity: isVisible ? 1 : 0,
                            transform: isVisible ? "scale(1) translateY(0)" : "scale(0.92) translateY(-6px)",
                            transition: "opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1), transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              closeItemMenu();
                              startInlineEdit(type, item.id, item.name);
                            }}
                            style={{
                              width: "100%",
                              padding: "10px 12px",
                              border: "none",
                              background: "transparent",
                              color: isLight ? "#14161A" : "#FFFFFF",
                              fontSize: 15,
                              fontWeight: 500,
                              cursor: "pointer",
                              outline: "none",
                              textAlign: "left",
                              transition: "background 0.2s",
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)"}
                            onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                          >
                            이름 바꾸기
                          </button>
                          {/* 다운로드 - 폴더면 하위 폴더/파일을 구조 그대로 담은 zip으로,
                              파일이면 그 파일 그대로 받는다. 꾹 눌러 선택해 둔 항목이 있으면
                              어느 항목의 메뉴에서 눌렀든 선택한 전체를 구조에 맞게 받는다. */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              closeItemMenu();
                              handleDownload(type, item.id);
                            }}
                            style={{
                              width: "100%",
                              padding: "10px 12px",
                              border: "none",
                              background: "transparent",
                              color: isLight ? "#14161A" : "#FFFFFF",
                              fontSize: 15,
                              fontWeight: 500,
                              cursor: downloadBusy ? "default" : "pointer",
                              opacity: downloadBusy ? 0.5 : 1,
                              outline: "none",
                              textAlign: "left",
                              transition: "background 0.2s",
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)"}
                            onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                          >
                            다운로드
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              closeItemMenu();
                              openMoveModal(type, item.id, item.name);
                            }}
                            style={{
                              width: "100%",
                              padding: "10px 12px",
                              border: "none",
                              background: "transparent",
                              color: isLight ? "#14161A" : "#FFFFFF",
                              fontSize: 15,
                              fontWeight: 500,
                              cursor: "pointer",
                              outline: "none",
                              textAlign: "left",
                              transition: "background 0.2s",
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)"}
                            onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                          >
                            이동
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              closeItemMenu();
                              openInfoModal(type, item.id);
                            }}
                            style={{
                              width: "100%",
                              padding: "10px 12px",
                              border: "none",
                              background: "transparent",
                              color: isLight ? "#14161A" : "#FFFFFF",
                              fontSize: 15,
                              fontWeight: 500,
                              cursor: "pointer",
                              outline: "none",
                              textAlign: "left",
                              transition: "background 0.2s",
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)"}
                            onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                          >
                            정보
                          </button>
                          <div style={{ height: 1, background: isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)" }} />
                          {(() => {
                            const deleteKey = `${type}-${item.id}`;
                            const isArmed = deleteArmedKey === deleteKey;
                            return (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (isArmed) {
                                    onDelete(item.id);
                                  } else {
                                    setDeleteArmedKey(deleteKey);
                                  }
                                }}
                                style={{
                                  width: "100%",
                                  padding: "10px 12px",
                                  border: "none",
                                  background: isArmed ? "#EF4444" : "transparent",
                                  color: isArmed ? "#FFFFFF" : "#EF4444",
                                  fontSize: 15,
                                  fontWeight: 500,
                                  cursor: "pointer",
                                  outline: "none",
                                  textAlign: "left",
                                  transition: "background 0.15s ease, color 0.15s ease",
                                }}
                                onMouseEnter={(e) => {
                                  if (!isArmed) e.currentTarget.style.background = isLight ? "rgba(239,68,68,0.06)" : "rgba(239,68,68,0.1)";
                                }}
                                onMouseLeave={(e) => {
                                  if (!isArmed) e.currentTarget.style.background = "transparent";
                                }}
                              >
                                삭제
                              </button>
                            );
                          })()}
                        </div>
                      </>,
                      document.body
                    )}
                  </div>
                );
              };

              // 항목 제목 텍스트 - 삼점 메뉴의 "이름 바꾸기"를 눌러야만 그 자리에서
              // 인라인 입력창으로 바뀌고, 포커스를 벗어나면 자동 저장된다. 모달 없음.
              const renderEditableName = (type, item, textStyle) => {
                const isEditing = editingItem && editingItem.type === type && editingItem.id === item.id;
                if (isEditing) {
                  return (
                    <input
                      type="text"
                      value={editingValue}
                      onChange={(e) => setEditingValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      onBlur={commitInlineEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      autoFocus
                      style={{
                        ...textStyle,
                        display: "block",
                        width: "100%",
                        boxSizing: "border-box",
                        background: isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.1)",
                        border: `1px solid ${isLight ? "rgba(20,22,26,0.3)" : "rgba(255,255,255,0.3)"}`,
                        borderRadius: 6,
                        padding: "1px 5px",
                        margin: "-1px -5px",
                        outline: "none",
                      }}
                    />
                  );
                }
                return (
                  <div
                    style={{
                      ...textStyle,
                      userSelect: "none",
                      WebkitUserSelect: "none",
                      WebkitTouchCallout: "none",
                    }}
                  >
                    {item.name}
                  </div>
                );
              };

              // 폴더/이미지/문서 제목 아래에 "#태그"를 작은 글씨로 나열한다. 누르면(클릭 전파를
              // 막아 상위 행의 이동 동작을 가로채지 않고) 검색/팔레트를 거치지 않고 곧바로
              // 그 태그가 달린 항목들을 모은 "분류" 화면을 연다.
              const renderTagPills = (item) => {
                if (!item.tags || item.tags.length === 0) return null;
                return (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 3 }}>
                    {item.tags.map((tag) => (
                      <span
                        key={tag}
                        onClick={(e) => {
                          e.stopPropagation();
                          openTagScreen(tag);
                        }}
                        style={{
                          fontSize: 12,
                          color: isLight ? "rgba(20,22,26,0.5)" : "rgba(255,255,255,0.58)",
                          cursor: "pointer",
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.textDecoration = "underline"}
                        onMouseLeave={(e) => e.currentTarget.style.textDecoration = "none"}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                );
              };

              // 선택 체크박스 - 선택 모드일 때만 나온다. 리스트 행에서는 아이콘 왼쪽에 인라인으로,
              // 이미지/폴더 갤러리 카드에서는 카드 왼쪽 상단에 겹쳐서(overlay) 놓는다.
              const renderSelectCheckbox = (type, id, overlay) => {
                if (!selectionMode) return null;
                const checked = isSelected(type, id);
                return (
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      // 롱프레스로 막 선택된 자리에 체크박스가 생겨난 경우, 손을 떼며
                      // 따라오는 click이 방금 선택한 것을 도로 해제하지 않도록 한 번 넘긴다.
                      if (justLongPressedRef.current) {
                        justLongPressedRef.current = false;
                        return;
                      }
                      toggleSelected(type, id);
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    aria-label="선택"
                    style={{
                      flexShrink: 0,
                      width: 20,
                      height: 20,
                      borderRadius: 6,
                      boxSizing: "border-box",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      border: `1.5px solid ${checked ? (isLight ? "#14161A" : "#FFFFFF") : (isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)")}`,
                      background: checked ? (isLight ? "#14161A" : "#FFFFFF") : (isLight ? "rgba(255,255,255,0.75)" : "rgba(20,20,19,0.6)"),
                      ...(overlay ? { position: "absolute", top: 6, left: 6, zIndex: 2 } : {}),
                    }}
                  >
                    {checked && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={isLight ? "#FFFFFF" : "#14161A"} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                );
              };

              // 선택 모드에서 항목을 누르면 폴더로 들어가거나 뷰어를 여는 대신 선택만 토글한다.
              // 롱프레스 직후 따라오는 click은 무시한다(그 클릭까지 처리하면 바로 해제돼 버린다).
              const handleItemClick = (type, id, normalAction) => {
                if (justLongPressedRef.current) {
                  justLongPressedRef.current = false;
                  return;
                }
                if (selectionMode) {
                  toggleSelected(type, id);
                  return;
                }
                normalAction();
              };

              // 선택된 항목의 테두리를 진하게 표시한다.
              const itemBorderColor = (type, id) =>
                isSelected(type, id)
                  ? (isLight ? "rgba(20,22,26,0.55)" : "rgba(255,255,255,0.6)")
                  : (isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)");

              // 폴더/문서 공용 행 렌더러 - 검색 결과 목록과 폴더 안 목록에서 함께 쓴다.
              const renderRow = (type, item, iconNode, subText, onNavigate) => {
                const rowType = type === "folder" ? "folder" : "file";
                return (
                <div
                  key={`${type}-${item.id}`}
                  data-item-type={rowType}
                  data-item-id={item.id}
                  onClick={() =>
                    handleItemClick(rowType, item.id, () => {
                      if (onNavigate) {
                        onNavigate();
                        return;
                      }
                      if (type === "folder") setCurrentPath([...currentPath, item.name]);
                    })
                  }
                  onPointerDown={rowPointerDown(rowType, item.id)}
                  onPointerMove={rowPointerMove}
                  onPointerUp={rowPointerUp}
                  onMouseDown={pressDown("scale(0.98)")}
                  onMouseUp={pressUp("none")}
                  onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.08)"}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)";
                    e.currentTarget.style.transform = "none";
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "18px 18px",
                    marginBottom: 8,
                    borderRadius: 10,
                    background: isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)",
                    backdropFilter: "blur(20px) saturate(180%)",
                    WebkitBackdropFilter: "blur(20px) saturate(180%)",
                    border: `1px solid ${itemBorderColor(rowType, item.id)}`,
                    cursor: type === "folder" || onNavigate || selectionMode ? "pointer" : "default",
                    touchAction: "manipulation",
                    userSelect: "none",
                    WebkitUserSelect: "none",
                    WebkitTouchCallout: "none",
                    transition: "background 0.2s ease, transform 0.15s ease, border-color 0.15s ease",
                  }}
                >
                  {/* 선택 체크박스는 파일/폴더 아이콘 바로 왼쪽에 온다 */}
                  {renderSelectCheckbox(rowType, item.id, false)}
                  <div style={{ flexShrink: 0 }}>{iconNode}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {renderEditableName(type === "folder" ? "folder" : "file", item, {
                      color: isLight ? "#14161A" : "#FFFFFF",
                      fontSize: 15,
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    })}
                    {renderTagPills(item)}
                    {subText && (
                      <div style={{ color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)", fontSize: 13, marginTop: 2 }}>
                        {subText}
                      </div>
                    )}
                  </div>
                  {renderItemMenu(type === "folder" ? "folder" : "file", item)}
                </div>
                );
              };

              // 이미지/움짤 콜라주(비율 유지한 2열 메이슨리) 렌더러 - 폴더 안 일반 목록과
              // "분류" 화면이 함께 쓴다. viewerImages는 뷰어를 열 때 넘길 전체 배열
              // (기본은 imagesArray 자신)로, "분류" 화면에서도 그 태그의 이미지들끼리 넘겨볼 수 있다.
              const renderImageCard = (img, imagesArray) => (
                <div
                  key={img.id}
                  data-item-type="file"
                  data-item-id={img.id}
                  onClick={() =>
                    handleItemClick("file", img.id, () => {
                      if (img.url) openViewer(imagesArray, imagesArray.findIndex((x) => x.id === img.id));
                    })
                  }
                  onPointerDown={rowPointerDown("file", img.id)}
                  onPointerMove={rowPointerMove}
                  onPointerUp={rowPointerUp}
                  onMouseDown={pressDown("scale(0.97)")}
                  onMouseUp={pressUp("none")}
                  style={{
                    position: "relative",
                    borderRadius: 10,
                    overflow: "hidden",
                    border: `1px solid ${itemBorderColor("file", img.id)}`,
                    background: isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)",
                    cursor: img.url || selectionMode ? "pointer" : "default",
                    touchAction: "manipulation",
                    userSelect: "none",
                    WebkitUserSelect: "none",
                    WebkitTouchCallout: "none",
                    transition: "border-color 0.15s ease, transform 0.15s ease",
                  }}
                >
                  {/* 선택 체크박스는 이미지 카드 왼쪽 상단에 겹쳐서 */}
                  {renderSelectCheckbox("file", img.id, true)}
                  {img.url ? (
                    <img
                      src={img.url}
                      alt={img.name}
                      draggable={false}
                      onLoad={handleImgAspectLoad(img.id)}
                      style={{ width: "100%", display: "block" }}
                    />
                  ) : (
                    <div style={{ padding: 24, display: "flex", justifyContent: "center" }}>
                      {getFileIcon(img.mimeType)}
                    </div>
                  )}
                  {/* 이미지 제목(좌) + 삼점 메뉴(우) - 하단 제목열에 나란히 정렬 */}
                  <div
                    style={{ display: "flex", alignItems: "flex-start", gap: 4, padding: "6px 4px 6px 8px" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {renderEditableName("file", img, {
                        color: isLight ? "#14161A" : "#FFFFFF",
                        fontSize: 12,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      })}
                      {renderTagPills(img)}
                    </div>
                    {renderItemMenu("file", img)}
                  </div>
                </div>
              );

              // 구글 포토 식 매이슨리(masonry) 배치 - 세로폭이 제각각인 이미지를 2열 그리드에
              // 그대로 넣으면(alignItems: start) 짧은 칸 아래에 빈 공간이 생긴다. 대신 각 이미지의
              // 실제 가로세로 비율(imgAspect, 로드 전엔 정사각형으로 가정)로 예상 높이를 구해서,
              // 매번 "지금까지 더 짧은 열"에 순서대로 채워 넣는 그리디(greedy) 방식으로 두 열의
              // 높이를 맞춘다. 각 열은 독립된 세로 목록이라 빈틈이 생기지 않는다.
              const splitImagesIntoColumns = (imagesArray) => {
                const columns = [[], []];
                const colHeights = [0, 0];
                imagesArray.forEach((img) => {
                  const ratio = imgAspect[img.id] || 1;
                  const col = colHeights[0] <= colHeights[1] ? 0 : 1;
                  columns[col].push(img);
                  colHeights[col] += 1 / ratio + 0.35; // 0.35 ~= 제목/태그 열 몫(비율 단위)
                });
                return columns;
              };

              // 이미지가 아주 많으면(수백~수천) 각 열을 독립적으로 가상 스크롤링해서, 화면 밖
              // 카드는 DOM에 아예 만들지 않는다.
              const renderImageGrid = (imagesArray, marginTop) => {
                if (imagesArray.length === 0) return null;
                const columns = splitImagesIntoColumns(imagesArray);
                const wrapStyle = { display: "flex", alignItems: "flex-start", gap: 8, marginTop };
                if (imagesArray.length <= VIRTUALIZE_THRESHOLD) {
                  return (
                    <div style={wrapStyle}>
                      {columns.map((col, ci) => (
                        <div key={ci} style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 0 }}>
                          {col.map((img) => renderImageCard(img, imagesArray))}
                        </div>
                      ))}
                    </div>
                  );
                }
                return (
                  <div style={wrapStyle}>
                    {columns.map((col, ci) => (
                      <div key={ci} style={{ flex: 1, minWidth: 0 }}>
                        <WindowVirtualList
                          count={col.length}
                          estimateSize={220}
                          renderItem={(index) => (
                            <div style={{ paddingBottom: 8 }}>{renderImageCard(col[index], imagesArray)}</div>
                          )}
                        />
                      </div>
                    ))}
                  </div>
                );
              };

              // 폴더 갤러리(마법사 "보기") 렌더러 - 이미지 콜라주와 같은 2열 그리드 골격을 쓰되,
              // 각 칸은 폴더의 커버 이미지(정보 모달의 "커버"로 지정)를 정중앙 기준 1:1로
              // 크롭해 보여준다(aspectRatio 고정 박스 + objectFit: cover). 커버가 없으면
              // 옅은 폴더 아이콘만 가운데에 둔다. 썸네일 밑에는 작은 폴더 아이콘 + 제목 +
              // 삼점 메뉴를 나란히 둔다 - 그래서 정사각형보다 살짝 세로로 긴 카드가 된다.
              const renderFolderGalleryCard = (folder) => {
                const cover = files.find((f) => f.id === folder.coverFileId && f.kind === "image");
                return (
                  <div
                    key={folder.id}
                    data-item-type="folder"
                    data-item-id={folder.id}
                    onClick={() => handleItemClick("folder", folder.id, () => setCurrentPath(folder.path))}
                    onPointerDown={rowPointerDown("folder", folder.id)}
                    onPointerMove={rowPointerMove}
                    onPointerUp={rowPointerUp}
                    onMouseDown={pressDown("scale(0.97)")}
                    onMouseUp={pressUp("none")}
                    style={{
                      position: "relative",
                      borderRadius: 10,
                      overflow: "hidden",
                      border: `1px solid ${itemBorderColor("folder", folder.id)}`,
                      background: isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)",
                      cursor: "pointer",
                      touchAction: "manipulation",
                      userSelect: "none",
                      WebkitUserSelect: "none",
                      WebkitTouchCallout: "none",
                      transition: "border-color 0.15s ease, transform 0.15s ease",
                    }}
                  >
                    {/* 선택 체크박스는 갤러리형 폴더 카드 왼쪽 상단에 겹쳐서 */}
                    {renderSelectCheckbox("folder", folder.id, true)}
                    <div
                      style={{
                        position: "relative",
                        width: "100%",
                        aspectRatio: "1 / 1",
                        overflow: "hidden",
                        background: isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)",
                      }}
                    >
                      {cover && cover.url ? (
                        <img
                          src={cover.url}
                          alt={folder.name}
                          draggable={false}
                          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                        />
                      ) : (
                        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <svg width="40" height="40" viewBox="0 0 24 24" fill={isLight ? "rgba(20,22,26,0.22)" : "rgba(255,255,255,0.22)"}>
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                          </svg>
                        </div>
                      )}
                    </div>
                    {/* 작은 폴더 아이콘(좌) + 제목 + 삼점 메뉴(우) */}
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 4px 6px 8px" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill={isLight ? "#14161A" : "#FFFFFF"} style={{ flexShrink: 0 }}>
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {renderEditableName("folder", folder, {
                          color: isLight ? "#14161A" : "#FFFFFF",
                          fontSize: 12,
                          fontWeight: 500,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        })}
                      </div>
                      {renderItemMenu("folder", folder)}
                    </div>
                  </div>
                );
              };

              const renderFolderGalleryGrid = (foldersArray) => {
                if (foldersArray.length === 0) return null;
                const gridStyle = { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", alignItems: "start", gap: 8 };
                if (foldersArray.length <= VIRTUALIZE_THRESHOLD) {
                  return <div style={gridStyle}>{foldersArray.map(renderFolderGalleryCard)}</div>;
                }
                const rows = chunkArray(foldersArray, 2);
                return (
                  <WindowVirtualList
                    count={rows.length}
                    estimateSize={220}
                    renderItem={(index) => (
                      <div style={{ ...gridStyle, paddingBottom: 8 }}>
                        {rows[index].map(renderFolderGalleryCard)}
                      </div>
                    )}
                  />
                );
              };

              // 문서 갤러리 카드 - 폴더 갤러리 카드와 같은 골격을 쓴다. 문서는 커버 이미지가
              // 없으니 위 칸에는 항상 옅은 문서 아이콘만 가운데 둔다.
              const renderDocGalleryCard = (doc) => (
                <div
                  key={doc.id}
                  data-item-type="file"
                  data-item-id={doc.id}
                  onClick={() => handleItemClick("file", doc.id, () => { if (doc.kind === "doc") openDocScreen(doc.id, "view"); })}
                  onPointerDown={rowPointerDown("file", doc.id)}
                  onPointerMove={rowPointerMove}
                  onPointerUp={rowPointerUp}
                  onMouseDown={pressDown("scale(0.97)")}
                  onMouseUp={pressUp("none")}
                  style={{
                    position: "relative",
                    borderRadius: 10,
                    overflow: "hidden",
                    border: `1px solid ${itemBorderColor("file", doc.id)}`,
                    background: isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)",
                    cursor: doc.kind === "doc" || selectionMode ? "pointer" : "default",
                    touchAction: "manipulation",
                    userSelect: "none",
                    WebkitUserSelect: "none",
                    WebkitTouchCallout: "none",
                    transition: "border-color 0.15s ease, transform 0.15s ease",
                  }}
                >
                  {renderSelectCheckbox("file", doc.id, true)}
                  <div
                    style={{
                      position: "relative",
                      width: "100%",
                      aspectRatio: "1 / 1",
                      overflow: "hidden",
                      background: isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <div style={{ opacity: 0.35 }}>{getFileIcon(doc.mimeType)}</div>
                  </div>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 4px 6px 8px" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div style={{ flexShrink: 0, transform: "scale(0.6)", transformOrigin: "center" }}>{getFileIcon(doc.mimeType)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {renderEditableName("file", doc, {
                        color: isLight ? "#14161A" : "#FFFFFF",
                        fontSize: 12,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      })}
                    </div>
                    {renderItemMenu("file", doc)}
                  </div>
                </div>
              );

              const renderDocGalleryGrid = (docsArray) => {
                if (docsArray.length === 0) return null;
                const gridStyle = { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", alignItems: "start", gap: 8 };
                if (docsArray.length <= VIRTUALIZE_THRESHOLD) {
                  return <div style={gridStyle}>{docsArray.map(renderDocGalleryCard)}</div>;
                }
                const rows = chunkArray(docsArray, 2);
                return (
                  <WindowVirtualList
                    count={rows.length}
                    estimateSize={220}
                    renderItem={(index) => (
                      <div style={{ ...gridStyle, paddingBottom: 8 }}>
                        {rows[index].map(renderDocGalleryCard)}
                      </div>
                    )}
                  />
                );
              };

              // 이미지 리스트 행 - 리스트형 보기일 때 이미지도 폴더/문서와 똑같은 행 모양으로
              // 보여준다(왼쪽에 정사각형으로 크롭한 작은 썸네일). renderRow를 그대로 쓴다.
              const renderImageRow = (img, imagesArray) =>
                renderRow(
                  "file",
                  img,
                  getFileIcon(img.mimeType),
                  null,
                  () => img.url && openViewer(imagesArray, imagesArray.findIndex((x) => x.id === img.id))
                );

              // ── "분류" 화면 - 태그 팔레트/분류 모달에서 태그를 고르면(tagScreenTags) 지금 어느 위치에
              //     있었든 상관없이 그 태그가 달린 폴더가 먼저 리스트로, 그 아래 이미지/움짤이
              //     갤러리로 온다. 폴더/이미지 모두 평소와 같은 삼점 메뉴 등 전체 레이아웃을 그대로 쓴다. ──
              if (tagScreenTags.length) {
                if (taggedFolders.length === 0 && taggedDocs.length === 0 && taggedImages.length === 0) {
                  return (
                    <div
                      style={{
                        padding: "48px 0",
                        textAlign: "center",
                        color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.45)",
                        fontSize: 14,
                      }}
                    >
                      이 태그가 달린 항목이 없습니다
                    </div>
                  );
                }
                return (
                  <>
                    {koSort(taggedFolders).map((folder) =>
                      renderRow(
                        "folder",
                        folder,
                        <svg width="22" height="22" viewBox="0 0 24 24" fill={isLight ? "#14161A" : "#FFFFFF"}>
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>,
                        folder.path.slice(0, -1).join(" / ") || "홈",
                        () => {
                          setCurrentPath(folder.path);
                          closeTagScreen();
                        }
                      )
                    )}
                    {koSort(taggedDocs).map((doc) =>
                      renderRow(
                        "file",
                        doc,
                        getFileIcon(doc.mimeType),
                        doc.path.join(" / ") || "홈",
                        doc.kind === "doc"
                          ? () => openDocScreen(doc.id, "view")
                          : () => {
                              setCurrentPath(doc.path);
                              closeTagScreen();
                            }
                      )
                    )}
                    {renderImageGrid(koSort(taggedImages), taggedFolders.length || taggedDocs.length ? 8 : 0)}
                  </>
                );
              }

              // ── 검색 결과: 검색어가 있으면 지금 어느 위치를 보고 있든 상관없이 전체
              //     폴더/파일/문서/이미지 중 이름에 검색어가 포함된 항목을 보여준다. 폴더/문서는
              //     리스트로, 이미지/움짤은 "분류" 화면과 동일한 콜라주 그리드로 보여준다. 현재
              //     정렬 모드(사용자 지정 순서 포함)와 무관하게 항상 가나다순이고, 폴더가 항상
              //     이미지보다 먼저(최상단) 온다. 항목을 누르면 검색을 닫고 해당 위치로 이동한다
              //     (이미지는 그리드와 동일하게 뷰어가 뜬다). ──
              const trimmedQuery = searchQuery.trim().toLowerCase();
              if (trimmedQuery) {
                // 검색어는 이름뿐 아니라 태그값도 대상으로 한다.
                // "#A #B"처럼 #으로 시작하는 낱말들을 쓰면 그 태그가 달린 항목을 모두
                // 보여준다(OR 조건) - 별도의 "분류" 화면으로 넘어가지 않고 이 검색 화면에
                // 그대로 나온다. #이 없는 낱말은 이름/태그 어디든 포함되면 걸린다.
                const tokens = trimmedQuery.split(/\s+/).filter(Boolean);
                const tagTokens = tokens.filter((t) => t.startsWith("#") && t.length > 1);
                const textQuery = tokens.filter((t) => !t.startsWith("#")).join(" ");
                const searchMatches = (item) => {
                  const itemTags = (item.tags || []).map((t) => t.toLowerCase());
                  if (tagTokens.length && !itemTags.some((t) => tagTokens.includes(t))) return false;
                  if (!textQuery) return true;
                  return item.name.toLowerCase().includes(textQuery) || itemTags.some((t) => t.includes(textQuery));
                };
                const folderMatches = koSort(folders.filter(searchMatches));
                const allFileMatches = files.filter(searchMatches);
                const docMatches = koSort(allFileMatches.filter((f) => f.kind !== "image"));
                const imageMatches = koSort(allFileMatches.filter((f) => f.kind === "image"));
                if (folderMatches.length === 0 && docMatches.length === 0 && imageMatches.length === 0) {
                  return (
                    <div
                      style={{
                        padding: "48px 0",
                        textAlign: "center",
                        color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.45)",
                        fontSize: 14,
                      }}
                    >
                      검색 결과가 없습니다
                    </div>
                  );
                }
                return (
                  // 검색 패널이 열려 있는 동안 화면 전체를 덮는 백드롭(zIndex 9, 바깥을 누르면
                  // 검색을 닫는 용도)이 결과 목록 위를 가로막지 않도록, 결과 목록은 그보다
                  // 높은 zIndex를 가진 별도 쌓임 맥락으로 렌더링한다.
                  <div style={{ position: "relative", zIndex: 11 }}>
                    {folderMatches.map((item) =>
                      renderRow(
                        "folder",
                        item,
                        <svg width="22" height="22" viewBox="0 0 24 24" fill={isLight ? "#14161A" : "#FFFFFF"}>
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>,
                        item.path.slice(0, -1).join(" / ") || "홈",
                        () => {
                          setCurrentPath(item.path);
                          setSearchQuery("");
                        }
                      )
                    )}
                    {docMatches.map((item) =>
                      renderRow(
                        "file",
                        item,
                        getFileIcon(item.mimeType),
                        item.path.join(" / ") || "홈",
                        item.kind === "doc"
                          ? () => {
                              setSearchQuery("");
                              openDocScreen(item.id, "view");
                            }
                          : () => {
                              setCurrentPath(item.path);
                              setSearchQuery("");
                            }
                      )
                    )}
                    {renderImageGrid(imageMatches, folderMatches.length || docMatches.length ? 8 : 0)}
                  </div>
                );
              }

              // ── 홈을 포함해 어디서든: 폴더(행) + 문서(행) + 이미지(콜라주) ──
              const visibleFolders = sortItems(
                folders.filter(
                  (f) =>
                    f.path.length === currentPath.length + 1 &&
                    f.path.slice(0, currentPath.length).every((p, i) => p === currentPath[i])
                )
              );
              const filesHere = files.filter(
                (f) =>
                  f.path.length === currentPath.length &&
                  f.path.every((p, i) => p === currentPath[i])
              );
              // 이미지가 아닌 파일은 모두 문서 행으로 보여준다("doc"/"text" 외의 kind를 가진(레거시 등)
              // 파일이 폴더 목록에서 조용히 누락되는 일이 없도록 - 변환/태그 모달의 대상 목록(kind로
              // 거르지 않음)과 항상 일치해야 한다.
              const visibleDocs = sortItems(filesHere.filter((f) => f.kind !== "image"));
              const visibleImages = sortItems(filesHere.filter((f) => f.kind === "image"));

              if (visibleFolders.length === 0 && visibleDocs.length === 0 && visibleImages.length === 0) {
                return (
                  <div
                    style={{
                      padding: "48px 0",
                      textAlign: "center",
                      color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.45)",
                      fontSize: 14,
                    }}
                  >
                    비어 있습니다
                  </div>
                );
              }

              // 폴더/문서 행 목록 - 항목이 아주 많으면(수백~수천) 가상 스크롤링으로 그린다.
              // 그 아래에서는 예전처럼 전부 그대로 그린다.
              const renderRowList = (items, renderOne, estimateSize) => {
                if (items.length <= VIRTUALIZE_THRESHOLD) return items.map(renderOne);
                return (
                  <WindowVirtualList
                    count={items.length}
                    estimateSize={estimateSize}
                    renderItem={(index) => renderOne(items[index])}
                  />
                );
              };

              const renderFolderRow = (folder) =>
                renderRow(
                  "folder",
                  folder,
                  <svg width="22" height="22" viewBox="0 0 24 24" fill={isLight ? "#14161A" : "#FFFFFF"}>
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>,
                  null
                );

              const renderDocRow = (doc) =>
                renderRow(
                  "file",
                  doc,
                  getFileIcon(doc.mimeType),
                  formatFileSize(doc.size),
                  doc.kind === "doc" ? () => openDocScreen(doc.id, "view") : null
                );

              // 마법사 "보기"는 폴더/문서/이미지 전부에 똑같이 적용된다 - 갤러리형이면
              // 셋 다 커버/아이콘이 있는 정사각형 카드 그리드로, 리스트형이면 셋 다 똑같은
              // 모양의 행으로 보여준다.
              return (
                <>
                  {galleryMode ? (
                    <div style={{ marginBottom: visibleDocs.length || visibleImages.length ? 8 : 0 }}>
                      {renderFolderGalleryGrid(visibleFolders)}
                    </div>
                  ) : (
                    renderRowList(visibleFolders, renderFolderRow, 68)
                  )}

                  {galleryMode ? (
                    <div style={{ marginBottom: visibleImages.length ? 8 : 0 }}>
                      {renderDocGalleryGrid(visibleDocs)}
                    </div>
                  ) : (
                    renderRowList(visibleDocs, renderDocRow, 68)
                  )}

                  {galleryMode ? (
                    renderImageGrid(visibleImages, 0)
                  ) : (
                    renderRowList(visibleImages, (img) => renderImageRow(img, visibleImages), 68)
                  )}
                </>
              );
            })()}
          </>
        )}

        {/* 설정 화면 - 상단 우측 설정(⚙) 버튼을 누르면 전체화면으로 열린다. 홈 탭 콘텐츠와
            같은 트리 안에 있지만 position:fixed 전체화면 오버레이라 실제로는 별도 화면처럼
            보인다(텍스트 에디터 등 다른 전체화면 화면들과 동일한 패턴). */}
        {settingsScreenOpen && (
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: isLight ? "#FAF9F5" : "#141413",
              zIndex: 49,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* 데스크탑 등 넓은 화면에서 설정/휴지통 내용도 CONTENT_MAX_WIDTH에서 잘라
                가운데 정렬한다 - 바깥 배경(위 div)은 계속 화면 전체를 채운다. */}
            <div
              style={{
                width: "100%",
                maxWidth: CONTENT_MAX_WIDTH,
                margin: "0 auto",
                minHeight: 0,
                flex: 1,
                display: "flex",
                flexDirection: "column",
              }}
            >
            <div
              style={{
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "20px 16px 12px 20px",
                paddingTop: "max(20px, env(safe-area-inset-top))",
              }}
            >
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: isLight ? "#14161A" : "#FFFFFF" }}>
                {trashScreenOpen ? "휴지통" : "설정"}
              </h1>
              <button
                onClick={() => {
                  if (trashScreenOpen) {
                    setTrashScreenOpen(false);
                    setTrashChecked({});
                  } else {
                    setSettingsScreenOpen(false);
                  }
                }}
                onMouseEnter={() => setTrashCloseButtonHovered(true)}
                onMouseLeave={(e) => {
                  setTrashCloseButtonHovered(false);
                  e.currentTarget.style.transform = "scale(1)";
                }}
                onMouseDown={pressDown("scale(0.9)")}
                onMouseUp={pressUp(trashCloseButtonHovered ? "scale(1.08)" : "scale(1)")}
                aria-label="닫기"
                style={{
                  width: TOP_BUTTON_SIZE,
                  height: TOP_BUTTON_SIZE,
                  flexShrink: 0,
                  borderRadius: "50%",
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                  background: trashCloseButtonHovered
                    ? (isLight ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.14)")
                    : (isLight ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.06)"),
                  backdropFilter: "blur(20px) saturate(180%)",
                  WebkitBackdropFilter: "blur(20px) saturate(180%)",
                  boxShadow: trashCloseButtonHovered
                    ? "0 10px 36px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.3)"
                    : "0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  color: isLight ? "#14161A" : "#FFFFFF",
                  outline: "none",
                  transition: "background 0.3s ease, box-shadow 0.3s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
                  transform: trashCloseButtonHovered ? "scale(1.08)" : "scale(1)",
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 24px 20px" }}>
            {!trashScreenOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                borderRadius: 14,
                background: isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)",
                backdropFilter: "blur(20px) saturate(180%)",
                WebkitBackdropFilter: "blur(20px) saturate(180%)",
                border: `1px solid ${isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)"}`,
                overflow: "hidden",
              }}
            >
              {/* 테마 행 - 텍스트 없이 해/달 아이콘으로만 구분되는 라이트/다크 전환 스위치.
                  "시스템 설정"이 켜져 있으면 이 스위치는 비활성화되고 투명도가 낮아진다. */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px" }}>
                <span style={{ fontSize: 15, fontWeight: 500, color: isLight ? "#14161A" : "#FFFFFF" }}>테마</span>
                <button
                  onClick={toggleLightDark}
                  onMouseDown={pressDown("scale(0.94)")}
                  onMouseUp={pressUp("scale(1)")}
                  disabled={useSystemTheme}
                  aria-label="라이트/다크 테마 전환"
                  style={{
                    position: "relative",
                    width: 64,
                    height: 32,
                    flexShrink: 0,
                    borderRadius: 999,
                    border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                    background: isLight ? "rgba(20,22,26,0.08)" : "rgba(255,255,255,0.1)",
                    cursor: useSystemTheme ? "default" : "pointer",
                    outline: "none",
                    padding: 0,
                    opacity: useSystemTheme ? 0.4 : 1,
                    transition: "background 0.3s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease",
                  }}
                >
                  {/* 트랙 좌우의 흐린 해/달 아이콘 */}
                  <span
                    style={{
                      position: "absolute",
                      left: 8,
                      top: "50%",
                      transform: "translateY(-50%)",
                      display: "flex",
                      color: isLight ? "transparent" : "rgba(255,255,255,0.4)",
                      transition: "color 0.3s ease",
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <circle cx="12" cy="12" r="4" />
                      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                    </svg>
                  </span>
                  <span
                    style={{
                      position: "absolute",
                      right: 8,
                      top: "50%",
                      transform: "translateY(-50%)",
                      display: "flex",
                      color: isLight ? "rgba(20,22,26,0.35)" : "transparent",
                      transition: "color 0.3s ease",
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
                    </svg>
                  </span>

                  {/* 슬라이딩 노브 - 현재 테마의 아이콘을 담고 좌우로 부드럽게 이동한다 */}
                  <span
                    style={{
                      position: "absolute",
                      top: 3,
                      left: isLight ? 3 : 33,
                      width: 26,
                      height: 26,
                      borderRadius: "50%",
                      background: isLight ? "#FFFFFF" : "#14161A",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transition: "left 0.3s cubic-bezier(0.22, 1, 0.36, 1), background 0.3s ease",
                    }}
                  >
                    {isLight ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F5A623" strokeWidth="2" strokeLinecap="round">
                        <circle cx="12" cy="12" r="4" />
                        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="#FFFFFF">
                        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
                      </svg>
                    )}
                  </span>
                </button>
              </div>

              {/* 테마 2열 - "시스템 설정" 작은 텍스트 바로 오른쪽에 체크박스. 켜면 OS(아이폰/
                  안드로이드/윈도우/맥 등)의 라이트·다크 모드를 그대로 따라간다. */}
              <div
                onClick={toggleUseSystemTheme}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "0 18px 14px 18px",
                  cursor: "pointer",
                }}
              >
                <span style={{ fontSize: 12, color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)" }}>
                  시스템 설정
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); toggleUseSystemTheme(); }}
                  onMouseDown={pressDown("scale(0.9)")}
                  onMouseUp={pressUp("scale(1)")}
                  aria-label="시스템 설정 사용"
                  role="checkbox"
                  aria-checked={useSystemTheme}
                  style={{
                    width: 18,
                    height: 18,
                    flexShrink: 0,
                    borderRadius: 5,
                    border: `1.5px solid ${useSystemTheme ? "transparent" : (isLight ? "rgba(20,22,26,0.30)" : "rgba(255,255,255,0.30)")}`,
                    background: useSystemTheme ? (isLight ? "#14161A" : "#FFFFFF") : "transparent",
                    cursor: "pointer",
                    outline: "none",
                    padding: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "background 0.2s ease, border-color 0.2s ease",
                  }}
                >
                  {useSystemTheme && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={isLight ? "#FFFFFF" : "#14161A"} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </button>
              </div>

              <div style={{ height: 1, background: isLight ? "rgba(20,22,26,0.1)" : "rgba(255,255,255,0.1)" }} />

              {/* 저장 공간 행 - 사용량만큼 채워지는 프로그레스 바 + 오른쪽에 "3.5GB/10GB" 텍스트 */}
              <div style={{ padding: "16px 18px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 15, fontWeight: 500, color: isLight ? "#14161A" : "#FFFFFF" }}>저장 공간</span>
                  <span style={{ fontSize: 12, color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)", display: "flex", alignItems: "center" }}>
                    {formatGBShort(usedStorageBytes)}/
                    {storageLimitEditing ? (
                      <input
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={storageLimitDraft}
                        onChange={(e) => setStorageLimitDraft(e.target.value)}
                        onBlur={commitStorageLimit}
                        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                        autoFocus
                        style={{
                          width: 44,
                          marginLeft: 2,
                          padding: 0,
                          border: "none",
                          borderBottom: `1px solid ${isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.35)"}`,
                          background: "transparent",
                          color: isLight ? "#14161A" : "#FFFFFF",
                          fontSize: 12,
                          outline: "none",
                        }}
                      />
                    ) : (
                      formatStorageLimitDisplay(storageLimitGB)
                    )}
                  </span>
                </div>
                <div
                  style={{
                    height: 8,
                    borderRadius: 999,
                    background: isLight ? "rgba(20,22,26,0.1)" : "rgba(255,255,255,0.1)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.min(100, (usedStorageBytes / STORAGE_MAX_BYTES) * 100)}%`,
                      borderRadius: 999,
                      background: isLight ? "#14161A" : "#FFFFFF",
                      transition: "width 0.3s ease",
                    }}
                  />
                </div>
                {/* 한도 설정 - 누르면 위 "0.0GB/10GB"의 10GB 부분이 인풋으로 바뀌어 직접
                    저장 공간 한도를 설정할 수 있다(10~1,000GB). */}
                <button
                  onClick={startEditStorageLimit}
                  style={{
                    display: "block",
                    marginTop: 4,
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    fontSize: 12,
                    color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)",
                    cursor: "pointer",
                    outline: "none",
                    textDecoration: "underline",
                    textUnderlineOffset: 2,
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = isLight ? "rgba(20,22,26,0.7)" : "rgba(255,255,255,0.7)"}
                  onMouseLeave={(e) => e.currentTarget.style.color = isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)"}
                >
                  한도 설정
                </button>
              </div>

              <div style={{ height: 1, background: isLight ? "rgba(20,22,26,0.1)" : "rgba(255,255,255,0.1)" }} />

              {/* 휴지통 행 - 누르면 휴지통 화면으로 이동 */}
              <div
                onClick={() => setTrashScreenOpen(true)}
                onMouseDown={pressDown("scale(0.98)")}
                onMouseUp={pressUp("scale(1)")}
                onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.04)" : "rgba(255,255,255,0.04)"}
                onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "16px 18px",
                  cursor: "pointer",
                  transition: "background 0.2s ease, transform 0.15s ease",
                }}
              >
                <span style={{ fontSize: 15, fontWeight: 500, color: isLight ? "#14161A" : "#FFFFFF" }}>휴지통</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {trash.length > 0 && (
                    <span style={{ fontSize: 13, color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)" }}>
                      {trash.length}
                    </span>
                  )}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.35)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </div>
              </div>
            </div>

            {/* 업로드 - 휴지통 카드 바로 아래. 원본/최적화 스위치로 업로드 방식을 고른다.
                최적화는 이미지/움짤에 한정해 원본 용량의 50% 수준으로 줄여서 올린다. 업로드
                도중 스위치를 바꿔도 이미 시작된 업로드에는 적용되지 않고, 그 다음 업로드부터
                반영된다(handleFilesPicked가 배치 시작 시점의 값을 그대로 고정해서 쓴다). */}
            <div
              style={{
                borderRadius: 14,
                background: isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)",
                backdropFilter: "blur(20px) saturate(180%)",
                WebkitBackdropFilter: "blur(20px) saturate(180%)",
                border: `1px solid ${isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)"}`,
                padding: "14px 18px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 500, color: isLight ? "#14161A" : "#FFFFFF" }}>업로드</span>
                <button
                  onClick={(e) => showInfoPopup("upload", e.currentTarget)}
                  disabled={infoPopupKind === "upload"}
                  aria-label="업로드 안내"
                  style={{
                    width: 18,
                    height: 18,
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    color: isLight ? "rgba(20,22,26,0.28)" : "rgba(255,255,255,0.28)",
                    cursor: infoPopupKind === "upload" ? "default" : "pointer",
                    outline: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: infoPopupKind === "upload" ? 0.5 : 1,
                    transition: "opacity 0.3s ease, color 0.2s ease",
                  }}
                  onMouseEnter={(e) => { if (infoPopupKind !== "upload") e.currentTarget.style.color = isLight ? "rgba(20,22,26,0.5)" : "rgba(255,255,255,0.5)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = isLight ? "rgba(20,22,26,0.28)" : "rgba(255,255,255,0.28)"; }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 2-3 4" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: uploadOptimizeEnabled ? 400 : 600,
                    color: uploadOptimizeEnabled
                      ? (isLight ? "rgba(20,22,26,0.4)" : "rgba(255,255,255,0.5)")
                      : (isLight ? "#14161A" : "#FFFFFF"),
                  }}
                >
                  원본
                </span>
                <button
                  onClick={() => setUploadOptimizeEnabled((v) => !v)}
                  onMouseDown={pressDown("scale(0.94)")}
                  onMouseUp={pressUp("scale(1)")}
                  role="switch"
                  aria-checked={uploadOptimizeEnabled}
                  aria-label="업로드 최적화"
                  style={{
                    position: "relative",
                    width: 38,
                    height: 21,
                    flexShrink: 0,
                    borderRadius: 999,
                    border: "none",
                    background: uploadOptimizeEnabled
                      ? (isLight ? "#14161A" : "#FFFFFF")
                      : (isLight ? "rgba(20,22,26,0.15)" : "rgba(255,255,255,0.15)"),
                    cursor: "pointer",
                    outline: "none",
                    padding: 0,
                    transition: "background 0.25s ease, transform 0.15s ease",
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      top: 2,
                      left: uploadOptimizeEnabled ? 19 : 2,
                      width: 17,
                      height: 17,
                      borderRadius: "50%",
                      background: isLight ? "#FFFFFF" : "#14161A",
                      boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
                      transition: "left 0.25s cubic-bezier(0.22, 1, 0.36, 1)",
                    }}
                  />
                </button>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: uploadOptimizeEnabled ? 600 : 400,
                    color: uploadOptimizeEnabled
                      ? (isLight ? "#14161A" : "#FFFFFF")
                      : (isLight ? "rgba(20,22,26,0.4)" : "rgba(255,255,255,0.5)"),
                  }}
                >
                  최적화
                </span>
              </div>
            </div>

            {/* 청구 금액 - 저장 공간 카드 바로 아래. 설정한 한도가 아니라 지금 실제로 쓰고
                있는 용량 기준이다. 제목 오른쪽의 물음표 아이콘을 누르면 요금 안내 패널이
                뜬다. 청구 금액이 0이어도 제목 밑에 "0$" 형태로 항상 표기한다(제목과
                비슷하게 굵고 큰 글씨로 눈에 띄게). */}
            <div
              style={{
                borderRadius: 14,
                background: isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)",
                backdropFilter: "blur(20px) saturate(180%)",
                WebkitBackdropFilter: "blur(20px) saturate(180%)",
                border: `1px solid ${isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)"}`,
                padding: "14px 18px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 15, fontWeight: 500, color: isLight ? "#14161A" : "#FFFFFF" }}>청구 금액</span>
                <button
                  onClick={(e) => showInfoPopup("pricing", e.currentTarget)}
                  disabled={infoPopupKind === "pricing"}
                  aria-label="요금 안내"
                  style={{
                    width: 18,
                    height: 18,
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    color: isLight ? "rgba(20,22,26,0.28)" : "rgba(255,255,255,0.28)",
                    cursor: infoPopupKind === "pricing" ? "default" : "pointer",
                    outline: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: infoPopupKind === "pricing" ? 0.5 : 1,
                    transition: "opacity 0.3s ease, color 0.2s ease",
                  }}
                  onMouseEnter={(e) => { if (infoPopupKind !== "pricing") e.currentTarget.style.color = isLight ? "rgba(20,22,26,0.5)" : "rgba(255,255,255,0.5)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = isLight ? "rgba(20,22,26,0.28)" : "rgba(255,255,255,0.28)"; }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 2-3 4" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </button>
              </div>
              <div style={{ fontSize: 13, fontWeight: 400, color: isLight ? "#14161A" : "#FFFFFF" }}>
                {(billingAmount % 1 === 0 ? billingAmount : parseFloat(billingAmount.toFixed(2)))}$
              </div>
            </div>

            {/* 계정 카드 - 로그인 상태에서는 로그아웃 버튼, 로그아웃 상태에서는 로그인 폼을
                같은 위치(청구 금액 카드 바로 아래)에 보여준다. 개인 웹사이트라 회원가입은
                없고 Supabase에 미리 등록해 둔 계정(이메일/비밀번호)으로만 로그인할 수 있다. */}
            {authUser && (
              <div
                style={{
                  borderRadius: 14,
                  background: isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)",
                  backdropFilter: "blur(20px) saturate(180%)",
                  WebkitBackdropFilter: "blur(20px) saturate(180%)",
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)"}`,
                  padding: "14px 18px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span style={{ fontSize: 15, fontWeight: 500, color: isLight ? "#14161A" : "#FFFFFF" }}>계정</span>
                <button
                  onClick={handleLogout}
                  style={{
                    minWidth: 36,
                    height: 30,
                    padding: "0 10px",
                    borderRadius: 8,
                    border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                    background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                    color: isLight ? "#14161A" : "#FFFFFF",
                    fontSize: 12,
                    fontWeight: 500,
                    letterSpacing: 0.2,
                    cursor: "pointer",
                    outline: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  로그아웃
                </button>
              </div>
            )}

            {!authUser && (
              <div
                style={{
                  borderRadius: 14,
                  background: isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)",
                  backdropFilter: "blur(20px) saturate(180%)",
                  WebkitBackdropFilter: "blur(20px) saturate(180%)",
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)"}`,
                  padding: "14px 18px",
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 500, color: isLight ? "#14161A" : "#FFFFFF", marginBottom: 10 }}>
                  계정
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 12, color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)", flexShrink: 0, width: 48 }}>
                    이메일
                  </span>
                  <input
                    type="text"
                    value={authIdDraft}
                    onChange={(e) => setAuthIdDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }}
                    maxLength={60}
                    autoCapitalize="off"
                    autoCorrect="off"
                    style={{
                      flex: "0 0 50%",
                      minWidth: 0,
                      padding: 0,
                      border: "none",
                      borderBottom: `1px solid ${isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.35)"}`,
                      background: "transparent",
                      color: isLight ? "#14161A" : "#FFFFFF",
                      fontSize: 16,
                      fontWeight: 500,
                      outline: "none",
                    }}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 12, color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)", flexShrink: 0, width: 48 }}>
                    비밀번호
                  </span>
                  <input
                    type="password"
                    value={authPasswordDraft}
                    onChange={(e) => setAuthPasswordDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }}
                    maxLength={40}
                    style={{
                      flex: "0 0 50%",
                      minWidth: 0,
                      padding: 0,
                      border: "none",
                      borderBottom: `1px solid ${isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.35)"}`,
                      background: "transparent",
                      color: isLight ? "#14161A" : "#FFFFFF",
                      fontSize: 16,
                      fontWeight: 500,
                      outline: "none",
                    }}
                  />
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button
                    onClick={handleLogin}
                    disabled={authBusy}
                    style={{
                      padding: "7px 14px",
                      borderRadius: 8,
                      border: "none",
                      background: isLight ? "#14161A" : "#FFFFFF",
                      color: isLight ? "#FFFFFF" : "#14161A",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: authBusy ? "default" : "pointer",
                      outline: "none",
                      opacity: authBusy ? 0.6 : 1,
                    }}
                  >
                    로그인
                  </button>
                </div>
              </div>
            )}
          </div>
            )}

            {/* 휴지통 화면 - 삭제된 폴더/파일이 삭제된 시점으로부터 7일간 여기 담긴다.
                복구를 누르면 원래 위치로 돌아가고, 삭제를 누르면 확인 절차 없이 바로 영구 삭제된다. */}
            {trashScreenOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {/* 제목 바로 밑 - 체크 아이콘 "전체 선택" 텍스트(좌, 변환/태그 모달과 동일한
                토글: 전부 체크돼 있으면 전체 해제, 아니면 전체 선택) + 삭제/복구 버튼(우측 정렬).
                두 버튼은 체크된 항목이 하나라도 있을 때만 활성화되고, 그 항목들에만 동작한다. */}
            {(() => {
              const hasChecked = trash.some((entry) => trashChecked[entry.id]);
              return (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <button
                    onClick={toggleTrashSelectAll}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: 0,
                      border: "none",
                      background: "transparent",
                      fontSize: 13,
                      fontWeight: 500,
                      color: hasChecked
                        ? (isLight ? "#14161A" : "#FFFFFF")
                        : (isLight ? "rgba(20,22,26,0.55)" : "rgba(255,255,255,0.55)"),
                      cursor: "pointer",
                      outline: "none",
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    전체 선택
                  </button>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button
                      onClick={deleteCheckedTrash}
                      disabled={!hasChecked}
                      style={{
                        padding: "6px 14px",
                        border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                        borderRadius: 8,
                        background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                        color: "#EF4444",
                        fontSize: 13,
                        fontWeight: 500,
                        cursor: hasChecked ? "pointer" : "default",
                        outline: "none",
                        opacity: hasChecked ? 1 : 0.4,
                        transition: "opacity 0.2s ease",
                      }}
                    >
                      삭제
                    </button>
                    <button
                      onClick={restoreCheckedTrash}
                      disabled={!hasChecked}
                      style={{
                        padding: "6px 14px",
                        border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                        borderRadius: 8,
                        background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                        color: isLight ? "#14161A" : "#FFFFFF",
                        fontSize: 13,
                        fontWeight: 500,
                        cursor: hasChecked ? "pointer" : "default",
                        outline: "none",
                        opacity: hasChecked ? 1 : 0.4,
                        transition: "opacity 0.2s ease",
                      }}
                    >
                      복구
                    </button>
                  </div>
                </div>
              );
            })()}
            {trash.length === 0 ? (
              <div
                style={{
                  padding: "48px 0",
                  textAlign: "center",
                  color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.45)",
                  fontSize: 14,
                }}
              >
                휴지통이 비어 있습니다
              </div>
            ) : (
              trash
                .slice()
                .sort((a, b) => b.deletedAt - a.deletedAt)
                .map((entry) => {
                  const daysLeft = Math.max(0, Math.ceil((entry.deletedAt + TRASH_RETENTION_MS - Date.now()) / (24 * 60 * 60 * 1000)));
                  return (
                    <div
                      key={entry.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "14px 16px",
                        borderRadius: 12,
                        background: isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)",
                        backdropFilter: "blur(20px) saturate(180%)",
                        WebkitBackdropFilter: "blur(20px) saturate(180%)",
                        border: `1px solid ${isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)"}`,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!!trashChecked[entry.id]}
                        onChange={() => toggleTrashChecked(entry.id)}
                        style={{ width: 18, height: 18, flexShrink: 0, cursor: "pointer" }}
                      />
                      <div style={{ flexShrink: 0 }}>
                        {entry.type === "vault" ? (
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={isLight ? "#14161A" : "#FFFFFF"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="20" height="20" rx="2.5" />
                            <circle cx="12" cy="12" r="4.5" />
                            <circle cx="12" cy="12" r="1" fill={isLight ? "#14161A" : "#FFFFFF"} stroke="none" />
                            <path d="M12 7.5v1M12 15.5v1M7.5 12h1M15.5 12h1" />
                          </svg>
                        ) : entry.type === "folder" ? (
                          <svg width="22" height="22" viewBox="0 0 24 24" fill={isLight ? "#14161A" : "#FFFFFF"}>
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                          </svg>
                        ) : (
                          getFileIcon(entry.files && entry.files[0] ? entry.files[0].mimeType : "")
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 15,
                            fontWeight: 500,
                            color: isLight ? "#14161A" : "#FFFFFF",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {entry.name}
                        </div>
                        <div style={{ fontSize: 12, color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)", marginTop: 2 }}>
                          {daysLeft}일 후 영구 삭제
                        </div>
                      </div>
                      <div
                        style={{ position: "relative", margin: -5, padding: 5, flexShrink: 0 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={(e) => toggleTrashItemMenu(entry.id, e.currentTarget)}
                          onMouseDown={pressDown("scale(0.85)")}
                          onMouseUp={pressUp("scale(1)")}
                          style={{
                            width: 30,
                            height: 30,
                            borderRadius: 7,
                            border: "none",
                            background: "transparent",
                            color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)",
                            cursor: "pointer",
                            outline: "none",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            transition: "all 0.2s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.08)";
                            e.currentTarget.style.color = isLight ? "#14161A" : "#FFFFFF";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "transparent";
                            e.currentTarget.style.color = isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)";
                          }}
                          aria-label="옵션"
                        >
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="5" r="2" />
                            <circle cx="12" cy="12" r="2" />
                            <circle cx="12" cy="19" r="2" />
                          </svg>
                        </button>

                        {trashItemMenuOpen === entry.id && createPortal(
                          <>
                            <div
                              onClick={(e) => { e.stopPropagation(); closeTrashItemMenu(); }}
                              style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 29 }}
                            />
                            <div
                              style={{
                                position: "fixed",
                                top: trashItemMenuAnchor.top,
                                right: trashItemMenuAnchor.right,
                                width: 148,
                                background: isLight ? "rgba(255,255,255,0.95)" : "rgba(20,20,19,0.95)",
                                backdropFilter: "blur(20px) saturate(180%)",
                                WebkitBackdropFilter: "blur(20px) saturate(180%)",
                                borderRadius: 12,
                                border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                                boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
                                zIndex: 30,
                                overflow: "hidden",
                                transformOrigin: "top right",
                                opacity: trashItemMenuVisible ? 1 : 0,
                                transform: trashItemMenuVisible ? "scale(1) translateY(0)" : "scale(0.92) translateY(-6px)",
                                transition: "opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1), transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  closeTrashItemMenu();
                                  restoreTrashItem(entry.id);
                                }}
                                style={{
                                  width: "100%",
                                  padding: "10px 12px",
                                  border: "none",
                                  background: "transparent",
                                  color: isLight ? "#14161A" : "#FFFFFF",
                                  fontSize: 15,
                                  fontWeight: 500,
                                  cursor: "pointer",
                                  outline: "none",
                                  textAlign: "left",
                                  transition: "background 0.2s",
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)"}
                                onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                              >
                                복구
                              </button>
                              <div style={{ height: 1, background: isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)" }} />
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  closeTrashItemMenu();
                                  permanentlyDeleteTrashItem(entry.id);
                                }}
                                style={{
                                  width: "100%",
                                  padding: "10px 12px",
                                  border: "none",
                                  background: "transparent",
                                  color: "#EF4444",
                                  fontSize: 15,
                                  fontWeight: 500,
                                  cursor: "pointer",
                                  outline: "none",
                                  textAlign: "left",
                                  transition: "background 0.15s ease",
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(239,68,68,0.06)" : "rgba(239,68,68,0.1)"}
                                onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                              >
                                삭제
                              </button>
                            </div>
                          </>,
                          document.body
                        )}
                      </div>
                    </div>
                  );
                })
            )}
          </div>
            )}
            </div>
          </div>
          </div>
        )}

      </div>

      {/* 정보 모달 - 이름/생성 일자/수정 일자/크기를 보여주는 단순 정보 모달.
          폴더/파일 공용. 별도 확인 버튼 없이 상단 제목열 오른쪽 X로만 닫는다. */}
      {infoModalOpen && (
        <>
          <div
            onClick={closeInfoModal}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0,0,0,0.45)",
              zIndex: 39,
              opacity: infoModalVisible ? 1 : 0,
              transition: "opacity 0.2s ease",
            }}
          />
          <div
            ref={infoModalRef}
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: infoModalVisible ? "translate(-50%, -50%) scale(1)" : "translate(-50%, -50%) scale(0.92)",
              opacity: infoModalVisible ? 1 : 0,
              background: isLight ? "#FFFFFF" : "#1a1918",
              borderRadius: 20,
              border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
              padding: "32px 30px",
              width: "84vw",
              boxSizing: "border-box",
              zIndex: 40,
              boxShadow: "0 30px 60px rgba(0,0,0,0.55)",
              transition: "opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1), transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <h2
                  style={{
                    margin: 0,
                    fontSize: 20,
                    fontWeight: 700,
                    color: isLight ? "#14161A" : "#FFFFFF",
                  }}
                >
                  정보
                </h2>
                {/* 커버 - 폴더일 때만 보여준다. 누르면 그 폴더 안의 이미지/움짤 중에서
                    갤러리형 보기일 때 카드에 쓸 커버를 고르는 선택 화면이 뜬다. */}
                {infoTarget && infoTarget.type === "folder" && (
                  <button
                    onClick={() => infoTarget && openCoverPicker(infoTarget.id)}
                    style={{
                      padding: 0,
                      border: "none",
                      background: "transparent",
                      color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.5)",
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: "pointer",
                      outline: "none",
                      textDecoration: "underline",
                    }}
                  >
                    섬네일
                  </button>
                )}
              </div>
              <button
                onClick={closeInfoModal}
                onMouseDown={pressDown("scale(0.85)")}
                onMouseUp={pressUp("scale(1)")}
                aria-label="닫기"
                style={{
                  flexShrink: 0,
                  width: 30,
                  height: 30,
                  borderRadius: 7,
                  border: "none",
                  background: "transparent",
                  color: isLight ? "rgba(20,22,26,0.55)" : "rgba(255,255,255,0.55)",
                  cursor: "pointer",
                  outline: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "background 0.2s ease, transform 0.15s ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.08)"}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.transform = "scale(1)"; }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 24 }}>
              {[
                { label: "이름", value: infoItem ? infoItem.name : "-" },
                { label: "생성 일자", value: infoItem ? formatDate(infoItem.createdAt) : "-" },
                { label: "수정 일자", value: infoItem ? formatDate(infoItem.updatedAt) : "-" },
                // 해상도 - 이미지/움짤 파일일 때만 "크기" 바로 위에 보여준다. 아직 불러오는
                // 중이면(infoImageDims === null) 빈 값 대신 로딩중임을 알 수 있게 "..."로 둔다.
                ...(infoTarget && infoTarget.type === "file" && infoItem?.kind === "image"
                  ? [{ label: "해상도", value: infoImageDims ? `${infoImageDims.w}x${infoImageDims.h}` : "..." }]
                  : []),
                { label: "크기", value: infoItem ? formatFileSize(infoItemSize) : "-" },
                // 확장자 - 폴더는 확장자 개념이 없으므로 파일(이미지/움짤/텍스트 등)일 때만 보여준다.
                // 이름(item.name)에는 더 이상 확장자를 담지 않으므로 ext 필드를 우선 쓰고,
                // ext가 없는 예전 데이터는 이름에서 파싱해 보여준다.
                ...(infoTarget && infoTarget.type === "file"
                  ? [{ label: "확장자", value: (() => {
                      if (infoItem?.ext) return `.${infoItem.ext}`;
                      const parts = (infoItem?.name || "").split(".");
                      return parts.length > 1 ? `.${parts.pop().toLowerCase()}` : "-";
                    })() }]
                  : []),
              ].map((row) => (
                <div key={row.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ color: isLight ? "rgba(20,22,26,0.5)" : "rgba(255,255,255,0.58)", fontSize: 15 }}>
                    {row.label}
                  </span>
                  <span
                    style={{
                      color: isLight ? "#14161A" : "#FFFFFF",
                      fontSize: 15,
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: "70%",
                    }}
                  >
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* 커버 선택 모달 - 정보 모달의 "커버"를 누르면 뜬다. 그 폴더 바로 안의 이미지/움짤을
          작은 그리드로 보여주고, 하나를 누르면 바로 커버로 지정되고 닫힌다. */}
      {coverPickerOpen && (
        <>
          <div
            onClick={closeCoverPicker}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0,0,0,0.45)",
              zIndex: 39,
              opacity: coverPickerVisible ? 1 : 0,
              transition: "opacity 0.2s ease",
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: coverPickerVisible ? "translate(-50%, -50%) scale(1)" : "translate(-50%, -50%) scale(0.92)",
              opacity: coverPickerVisible ? 1 : 0,
              background: isLight ? "#FFFFFF" : "#1a1918",
              borderRadius: 20,
              border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
              padding: "32px 30px",
              width: "84vw",
              height: coverPickerHeight || undefined,
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              zIndex: 40,
              boxShadow: "0 30px 60px rgba(0,0,0,0.55)",
              transition: "opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1), transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, flexShrink: 0 }}>
              <h2
                style={{
                  margin: 0,
                  fontSize: 20,
                  fontWeight: 700,
                  color: isLight ? "#14161A" : "#FFFFFF",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                섬네일
              </h2>
              <button
                onClick={closeCoverPicker}
                onMouseDown={pressDown("scale(0.85)")}
                onMouseUp={pressUp("scale(1)")}
                aria-label="닫기"
                style={{
                  flexShrink: 0,
                  width: 30,
                  height: 30,
                  borderRadius: 7,
                  border: "none",
                  background: "transparent",
                  color: isLight ? "rgba(20,22,26,0.55)" : "rgba(255,255,255,0.55)",
                  cursor: "pointer",
                  outline: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "background 0.2s ease, transform 0.15s ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.08)"}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.transform = "scale(1)"; }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            </div>

            {coverPickerImages.length === 0 ? (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                  color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.45)",
                  fontSize: 14,
                }}
              >
                이 폴더에 이미지가 없습니다
              </div>
            ) : (
              // 3열 그리드 - 예전엔 CSS Grid(gridTemplateColumns)를 썼는데, aspectRatio로
              // 높이를 정하는 칸을 스크롤 가능한 grid 트랙 안에 넣으면 브라우저가 트랙
              // 높이를 실제 정사각형 높이가 아니라 훨씬 작은 값으로 잘못 계산해서(트랙이
              // auto 사이징을 정확히 못 잡음) 이미지가 다음 줄과 겹쳐 보이는 문제가 있었다.
              // flex + flexWrap은 각 칸의 높이를 그 칸 자신의 aspectRatio로 바로 정하기
              // 때문에 이런 트랙 계산 문제가 없다.
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexWrap: "wrap", alignContent: "flex-start", gap: 8 }}>
                {coverPickerImages.map((img) => {
                  const isSelected = coverPickerFolder && coverPickerFolder.coverFileId === img.id;
                  return (
                    <div
                      key={img.id}
                      onClick={() => setFolderCover(coverPickerFolderId, img.id)}
                      onMouseDown={pressDown("scale(0.95)")}
                      onMouseUp={pressUp("scale(1)")}
                      style={{
                        position: "relative",
                        boxSizing: "border-box",
                        width: "calc((100% - 16px) / 3)",
                        aspectRatio: "1 / 1",
                        flexShrink: 0,
                        borderRadius: 8,
                        overflow: "hidden",
                        cursor: "pointer",
                        border: `2px solid ${isSelected ? (isLight ? "#14161A" : "#FFFFFF") : "transparent"}`,
                        background: isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)",
                      }}
                    >
                      {img.url && (
                        <img
                          src={img.url}
                          alt={img.name}
                          draggable={false}
                          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* 폴더 생성 모달 - 배경 페이드 + 카드 스케일 인/아웃 애니메이션 */}
      {folderModalOpen && (
        <>
          <div
            onClick={closeFolderModal}
            style={{
              position: "fixed",
              top: 0,
          left: 0,
          right: 0,
          bottom: 0,
              background: "rgba(0,0,0,0.4)",
              zIndex: 39,
              opacity: folderModalVisible ? 1 : 0,
              transition: "opacity 0.2s ease",
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: folderModalVisible ? "translate(-50%, -50%) scale(1)" : "translate(-50%, -50%) scale(0.92)",
              opacity: folderModalVisible ? 1 : 0,
              background: isLight ? "#FFFFFF" : "#1a1918",
              borderRadius: 16,
              border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
              padding: "24px 30px",
              width: "84vw",
              boxSizing: "border-box",
              zIndex: 40,
              boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
              transition: "opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1), transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              style={{
                margin: "0 0 16px 0",
                fontSize: 19,
                fontWeight: 700,
                color: isLight ? "#14161A" : "#FFFFFF",
              }}
            >
              폴더 만들기
            </h2>
            <input
              type="text"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder="폴더 이름"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") createFolder();
                if (e.key === "Escape") closeFolderModal();
              }}
              style={{
                width: "100%",
                padding: 12,
                marginBottom: 20,
                border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                borderRadius: 8,
                background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                color: isLight ? "#14161A" : "#FFFFFF",
                fontSize: 15,
                outline: "none",
                boxSizing: "border-box",
                transition: "border-color 0.2s ease",
              }}
            />
            <div style={{ display: "flex", gap: 12 }}>
              <button
                onClick={closeFolderModal}
                onMouseDown={pressDown("scale(0.95)")}
                onMouseUp={pressUp("scale(1)")}
                style={{
                  flex: 1,
                  padding: 10,
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                  borderRadius: 8,
                  background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                  color: isLight ? "#14161A" : "#FFFFFF",
                  fontSize: 15,
                  fontWeight: 500,
                  cursor: "pointer",
                  outline: "none",
                  transition: "background 0.2s ease, transform 0.15s ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.1)"}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)";
                  e.currentTarget.style.transform = "scale(1)";
                }}
              >
                취소
              </button>
              <button
                onClick={createFolder}
                onMouseDown={pressDown("scale(0.95)")}
                onMouseUp={pressUp("scale(1)")}
                style={{
                  flex: 1,
                  padding: 10,
                  border: "none",
                  borderRadius: 8,
                  background: isLight ? "#14161A" : "#FFFFFF",
                  color: isLight ? "#FFFFFF" : "#14161A",
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: "pointer",
                  outline: "none",
                  transition: "transform 0.15s ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.transform = "translateY(-1px)"}
                onMouseLeave={(e) => e.currentTarget.style.transform = "translateY(0)"}
              >
                확인
              </button>
            </div>
          </div>
        </>
      )}

      {/* 문서 만들기 모달 - 폴더 만들기와 완전히 동일한 UI를 쓴다. 확인하면 지금 위치에
          빈 마크다운 문서를 만들고 바로 편집 화면을 연다. */}
      {docCreateModalOpen && (
        <>
          <div
            onClick={closeDocCreateModal}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0,0,0,0.4)",
              zIndex: 39,
              opacity: docCreateModalVisible ? 1 : 0,
              transition: "opacity 0.2s ease",
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: docCreateModalVisible ? "translate(-50%, -50%) scale(1)" : "translate(-50%, -50%) scale(0.92)",
              opacity: docCreateModalVisible ? 1 : 0,
              background: isLight ? "#FFFFFF" : "#1a1918",
              borderRadius: 16,
              border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
              padding: "24px 30px",
              width: "84vw",
              boxSizing: "border-box",
              zIndex: 40,
              boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
              transition: "opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1), transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              style={{
                margin: "0 0 16px 0",
                fontSize: 19,
                fontWeight: 700,
                color: isLight ? "#14161A" : "#FFFFFF",
              }}
            >
              문서 만들기
            </h2>
            <input
              type="text"
              value={docNameDraft}
              onChange={(e) => setDocNameDraft(e.target.value)}
              placeholder="문서 이름"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") createDoc();
                if (e.key === "Escape") closeDocCreateModal();
              }}
              style={{
                width: "100%",
                padding: 12,
                marginBottom: 20,
                border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                borderRadius: 8,
                background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                color: isLight ? "#14161A" : "#FFFFFF",
                fontSize: 15,
                outline: "none",
                boxSizing: "border-box",
                transition: "border-color 0.2s ease",
              }}
            />
            <div style={{ display: "flex", gap: 12 }}>
              <button
                onClick={closeDocCreateModal}
                onMouseDown={pressDown("scale(0.95)")}
                onMouseUp={pressUp("scale(1)")}
                style={{
                  flex: 1,
                  padding: 10,
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                  borderRadius: 8,
                  background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                  color: isLight ? "#14161A" : "#FFFFFF",
                  fontSize: 15,
                  fontWeight: 500,
                  cursor: "pointer",
                  outline: "none",
                  transition: "background 0.2s ease, transform 0.15s ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.1)"}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)";
                  e.currentTarget.style.transform = "scale(1)";
                }}
              >
                취소
              </button>
              <button
                onClick={createDoc}
                onMouseDown={pressDown("scale(0.95)")}
                onMouseUp={pressUp("scale(1)")}
                style={{
                  flex: 1,
                  padding: 10,
                  border: "none",
                  borderRadius: 8,
                  background: isLight ? "#14161A" : "#FFFFFF",
                  color: isLight ? "#FFFFFF" : "#14161A",
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: "pointer",
                  outline: "none",
                  transition: "transform 0.15s ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.transform = "translateY(-1px)"}
                onMouseLeave={(e) => e.currentTarget.style.transform = "translateY(0)"}
              >
                확인
              </button>
            </div>
          </div>
        </>
      )}

      {/* 문서 화면 - 마크다운 문서를 읽거나 편집하는 전체화면. 설정 화면과 같은 패턴의
          position:fixed 전체화면 오버레이다. "보기"에서는 렌더링 결과만 꽉 차게, "편집"에서는
          원문 입력창과 그 아래 실시간 미리보기를 함께 보여준다(타이핑하는 즉시 반영). 저장은
          별도 버튼 없이 다른 항목들과 동일하게 편집하는 즉시 자동 저장된다. */}
      {docScreenOpen && docScreenFile && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: isLight ? "#FAF9F5" : "#141413",
            zIndex: 49,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: CONTENT_MAX_WIDTH,
              margin: "0 auto",
              minHeight: 0,
              flex: 1,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "20px 16px 12px 20px",
                paddingTop: "max(20px, env(safe-area-inset-top))",
                borderBottom: `1px solid ${isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)"}`,
              }}
            >
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  color: isLight ? "#14161A" : "#FFFFFF",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {docScreenFile.name}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                {/* 수정하기 - 우상단 설정 버튼과 동일한 크기의 리퀴드 글라스 원형 버튼. */}
                <button
                  onClick={() => setDocScreenMode((m) => (m === "edit" ? "view" : "edit"))}
                  onMouseEnter={() => setDocEditButtonHovered(true)}
                  onMouseLeave={(e) => {
                    setDocEditButtonHovered(false);
                    e.currentTarget.style.transform = "scale(1)";
                  }}
                  onMouseDown={pressDown("scale(0.9)")}
                  onMouseUp={pressUp(docEditButtonHovered ? "scale(1.08)" : "scale(1)")}
                  onTouchStart={pressDown("scale(0.9)")}
                  onTouchEnd={pressUp("scale(1)")}
                  aria-label={docScreenMode === "edit" ? "완료" : "수정하기"}
                  title={docScreenMode === "edit" ? "완료" : "수정하기"}
                  style={{
                    width: TOP_BUTTON_SIZE,
                    height: TOP_BUTTON_SIZE,
                    flexShrink: 0,
                    borderRadius: "50%",
                    border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                    background: docEditButtonHovered
                      ? (isLight ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.14)")
                      : (isLight ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.06)"),
                    backdropFilter: "blur(20px) saturate(180%)",
                    WebkitBackdropFilter: "blur(20px) saturate(180%)",
                    boxShadow: docEditButtonHovered
                      ? "0 10px 36px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.3)"
                      : "0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    color: isLight ? "#14161A" : "#FFFFFF",
                    outline: "none",
                    transition: "background 0.3s ease, box-shadow 0.3s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
                    transform: docEditButtonHovered ? "scale(1.08)" : "scale(1)",
                  }}
                >
                  {docScreenMode === "edit" ? (
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                    </svg>
                  )}
                </button>
                {/* 닫기 - 설정 버튼과 완전히 동일한 디자인/크기. */}
                <button
                  onClick={closeDocScreen}
                  onMouseEnter={() => setDocCloseButtonHovered(true)}
                  onMouseLeave={(e) => {
                    setDocCloseButtonHovered(false);
                    e.currentTarget.style.transform = "scale(1)";
                  }}
                  onMouseDown={pressDown("scale(0.9)")}
                  onMouseUp={pressUp(docCloseButtonHovered ? "scale(1.08)" : "scale(1)")}
                  onTouchStart={pressDown("scale(0.9)")}
                  onTouchEnd={pressUp("scale(1)")}
                  aria-label="닫기"
                  style={{
                    width: TOP_BUTTON_SIZE,
                    height: TOP_BUTTON_SIZE,
                    flexShrink: 0,
                    borderRadius: "50%",
                    border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                    background: docCloseButtonHovered
                      ? (isLight ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.14)")
                      : (isLight ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.06)"),
                    backdropFilter: "blur(20px) saturate(180%)",
                    WebkitBackdropFilter: "blur(20px) saturate(180%)",
                    boxShadow: docCloseButtonHovered
                      ? "0 10px 36px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.3)"
                      : "0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    color: isLight ? "#14161A" : "#FFFFFF",
                    outline: "none",
                    transition: "background 0.3s ease, box-shadow 0.3s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
                    transform: docCloseButtonHovered ? "scale(1.08)" : "scale(1)",
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="6" y1="6" x2="18" y2="18" />
                    <line x1="18" y1="6" x2="6" y2="18" />
                  </svg>
                </button>
              </div>
            </div>

            {docScreenMode === "view" ? (
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 20px 40px 20px" }}>
                {renderMarkdown(docScreenFile.content || "")}
              </div>
            ) : (
              // 편집 - 별도 미리보기 없이 이 자리에서 바로 문법이 적용되어 보인다.
              // 문법 기호는 흐리게 남아있어 원문이 그대로 보존된다.
              <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
                {!docScreenFile.content && (
                  <div
                    style={{
                      position: "absolute",
                      top: 18,
                      left: 20,
                      color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.35)",
                      fontSize: 15,
                      lineHeight: 1.7,
                      pointerEvents: "none",
                    }}
                  >
                    마크다운으로 적어보세요 - # 제목, **굵게**, - 목록 ...
                  </div>
                )}
                <div
                  ref={docEditableRef}
                  contentEditable
                  suppressContentEditableWarning
                  autoFocus
                  onCompositionStart={() => { docComposingRef.current = true; }}
                  onCompositionEnd={handleDocEditableCompositionEnd(docScreenFile.id)}
                  style={{
                    height: "100%",
                    overflowY: "auto",
                    outline: "none",
                    padding: "18px 20px 40px 20px",
                    color: isLight ? "#14161A" : "#FFFFFF",
                    fontSize: 15,
                    lineHeight: 1.7,
                    fontFamily: "inherit",
                    boxSizing: "border-box",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* 이동 모달 - 최상위 홈부터 폴더를 탐색하며 옮길 위치를 고른다.
          다른 모달과 동일한 페이드+스케일 애니메이션, 빈 배경 클릭 시 취소 */}
      {moveModalOpen && (
        <>
          <div
            onClick={closeMoveModal}
            style={{
              position: "fixed",
              top: 0,
          left: 0,
          right: 0,
          bottom: 0,
              background: "rgba(0,0,0,0.4)",
              zIndex: 39,
              opacity: moveModalVisible ? 1 : 0,
              transition: "opacity 0.2s ease",
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: moveModalVisible ? "translate(-50%, -50%) scale(1)" : "translate(-50%, -50%) scale(0.92)",
              opacity: moveModalVisible ? 1 : 0,
              background: isLight ? "#FFFFFF" : "#1a1918",
              borderRadius: 20,
              border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
              padding: "32px 30px",
              width: "84vw",
              boxSizing: "border-box",
              zIndex: 40,
              boxShadow: "0 30px 60px rgba(0,0,0,0.55)",
              transition: "opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1), transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 4 }}>
              <h2
                style={{
                  margin: 0,
                  fontSize: 19,
                  fontWeight: 700,
                  color: isLight ? "#14161A" : "#FFFFFF",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {moveTarget ? moveTarget.name : "이동"}
              </h2>
              <button
                onClick={closeMoveModal}
                onMouseDown={pressDown("scale(0.85)")}
                onMouseUp={pressUp("scale(1)")}
                aria-label="닫기"
                style={{
                  flexShrink: 0,
                  width: 30,
                  height: 30,
                  borderRadius: 7,
                  border: "none",
                  background: "transparent",
                  color: isLight ? "rgba(20,22,26,0.55)" : "rgba(255,255,255,0.55)",
                  cursor: "pointer",
                  outline: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "background 0.2s ease, transform 0.15s ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.08)"}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.transform = "scale(1)"; }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 4,
                margin: "12px 0",
                paddingBottom: 12,
                borderBottom: `1px solid ${isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)"}`,
              }}
            >
              <button
                onClick={() => setMoveBrowsePath([])}
                style={{
                  background: "none",
                  border: "none",
                  color: isLight ? "#14161A" : "#FFFFFF",
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: "pointer",
                  padding: 0,
                  outline: "none",
                  opacity: moveBrowsePath.length === 0 ? 1 : 0.7,
                }}
              >
                홈
              </button>
              {moveBrowsePath.map((seg, index) => (
                <div key={index} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)", fontSize: 14 }}>&gt;</span>
                  <button
                    onClick={() => setMoveBrowsePath(moveBrowsePath.slice(0, index + 1))}
                    style={{
                      background: "none",
                      border: "none",
                      color: isLight ? "#14161A" : "#FFFFFF",
                      fontSize: 14,
                      fontWeight: 500,
                      cursor: "pointer",
                      padding: 0,
                      outline: "none",
                      opacity: index === moveBrowsePath.length - 1 ? 1 : 0.7,
                    }}
                  >
                    {seg}
                  </button>
                </div>
              ))}
            </div>

            <div style={{ maxHeight: 300, overflowY: "auto", marginBottom: 16 }}>
              {moveModalEntries.length === 0 ? (
                <div
                  style={{
                    padding: "24px 0",
                    textAlign: "center",
                    color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.45)",
                    fontSize: 14,
                  }}
                >
                  {moveBrowsePath.length === 0 ? "폴더가 없습니다" : "하위 폴더가 없습니다"}
                </div>
              ) : (
                moveModalEntries.map((entry) => (
                  <div
                    key={entry.id}
                    onClick={() => setMoveBrowsePath([...moveBrowsePath, entry.name])}
                    onMouseDown={pressDown("scale(0.98)")}
                    onMouseUp={pressUp("scale(1)")}
                    onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.08)"}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                      e.currentTarget.style.transform = "scale(1)";
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 8px",
                      borderRadius: 8,
                      cursor: "pointer",
                      transition: "background 0.2s ease, transform 0.15s ease",
                    }}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill={isLight ? "#14161A" : "#FFFFFF"} style={{ flexShrink: 0 }}>
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <div
                      style={{
                        flex: 1,
                        color: isLight ? "#14161A" : "#FFFFFF",
                        fontSize: 15,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {entry.name}
                    </div>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.35)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </div>
                ))
              )}
            </div>

            <button
              onClick={confirmMove}
              disabled={!canDropHere}
              onMouseDown={canDropHere ? pressDown("scale(0.95)") : undefined}
              onMouseUp={canDropHere ? pressUp("scale(1)") : undefined}
              style={{
                width: "100%",
                padding: 10,
                border: "none",
                borderRadius: 8,
                background: isLight ? "#14161A" : "#FFFFFF",
                color: isLight ? "#FFFFFF" : "#14161A",
                fontSize: 15,
                fontWeight: 600,
                cursor: canDropHere ? "pointer" : "not-allowed",
                opacity: canDropHere ? 1 : 0.4,
                outline: "none",
                transition: "transform 0.15s ease, opacity 0.2s ease",
              }}
              onMouseEnter={(e) => { if (canDropHere) e.currentTarget.style.transform = "translateY(-1px)"; }}
              onMouseLeave={(e) => e.currentTarget.style.transform = "translateY(0)"}
            >
              이동
            </button>
          </div>
        </>
      )}

      {/* 동기화 표시 - 홈/폴더 화면 하단 중앙에 작게 "☁ 동기화"를 계속 띄워둔다. 방금
          바뀐 내용(폴더 생성/이미지 업로드 등)이 DB에 정상 저장되고 있는 동안만 보이고,
          저장이 실패하거나 인터넷이 끊기면 조용히 사라진다(별도 경고 없이 - 저장 실패
          자체는 위 저장 이펙트가 서브 액션바로 따로 알린다). 설정 화면에서는 숨긴다. */}
      {authUser && !settingsScreenOpen && dbSyncOk && isOnline && (
        <div
          style={{
            position: "fixed",
            bottom: 14,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 3,
            display: "flex",
            alignItems: "center",
            gap: 5,
            pointerEvents: "none",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.4)"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.5 19H6.5A4.5 4.5 0 0 1 6 10.03 5.5 5.5 0 0 1 16.9 8.5 4.5 4.5 0 0 1 17.5 19z" />
          </svg>
          <span style={{ fontSize: 11, fontWeight: 500, color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.4)" }}>
            동기화
          </span>
        </div>
      )}

      {/* 서브 액션바 - "데이터를 삭제했습니다"/"데이터를 복구했습니다" 같은 짧은 안내를
          하단 탭바 바로 위에 2초간 페이드 인/아웃으로 보여준다. */}
      {toastMessage && (
        <div
          style={{
            position: "fixed",
            bottom: 24 + BAR_HEIGHT + 14,
            left: "50%",
            transform: toastVisible ? "translate(-50%, 0)" : "translate(-50%, 8px)",
            opacity: toastVisible ? 1 : 0,
            zIndex: 50,
            padding: "12px 22px",
            borderRadius: 999,
            background: isLight ? "rgba(255,255,255,0.85)" : "rgba(30,29,28,0.85)",
            backdropFilter: "blur(20px) saturate(180%)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
            boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
            color: isLight ? "#14161A" : "#FFFFFF",
            fontSize: 14,
            fontWeight: 500,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            transition: "opacity 0.3s ease, transform 0.3s ease",
          }}
        >
          {toastMessage}
        </div>
      )}

      {/* 업로드/다운로드 현황 패널 - 화면 우측 하단에 떠서 파일별 진행/완료/대기 상태와
          전송량을 보여준다. 두 패널은 완전히 같은 디자인/로직을 쓰며, 동시에 떠 있으면
          겹치지 않도록 세로로 쌓인다. 새 작업이 시작되면 다시 나타나고, X를 누르면
          닫힌다(작업 자체는 백그라운드에서 계속된다). */}
      {(uploadQueue.length > 0 && !uploadPanelClosed) || (downloadQueue.length > 0 && !downloadPanelClosed) ? (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 45,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 12,
          }}
        >
          {renderTransferPanel("다운로드", downloadQueue, downloadPanelClosed, () => setDownloadPanelClosed(true))}
          {renderTransferPanel("업로드", uploadQueue, uploadPanelClosed, () => setUploadPanelClosed(true))}
        </div>
      ) : null}

      {/* 안내 팝업 - 서브 액션바와 같은 리퀴드 글래스 배경을 쓰되, 하단 고정이 아니라
          눌린 물음표 아이콘 바로 밑 위치(infoPopupPos)에 뜬다. 레이아웃 흐름에 얹지 않고
          document.body에 포탈로 띄워 다른 내용을 밀어내지 않는다. kind로 요금/업로드
          안내 중 어떤 물음표를 눌렀는지에 따라 내용만 바꾼다. */}
      {infoPopupKind && createPortal(
        <div
          style={{
            position: "fixed",
            top: infoPopupPos.top,
            left: infoPopupPos.left,
            transform: infoPopupVisible ? "translateY(0)" : "translateY(8px)",
            opacity: infoPopupVisible ? 1 : 0,
            zIndex: 50,
            padding: "12px 16px",
            borderRadius: 14,
            background: isLight ? "rgba(255,255,255,0.85)" : "rgba(30,29,28,0.85)",
            backdropFilter: "blur(20px) saturate(180%)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
            boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
            pointerEvents: "none",
            transition: "opacity 0.3s ease, transform 0.3s ease",
            maxWidth: 260,
          }}
        >
          {infoPopupKind === "pricing" ? (
            <div style={{ fontSize: 12, fontWeight: 400, color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)" }}>
              할당된 저장 공간 10GB를 초과하면 0.15$/GB가 청구됩니다
            </div>
          ) : (
            <div style={{ fontSize: 12, fontWeight: 400, color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)" }}>
              이미지 확장자에 적용되며 약 50%의 저장 공간을 절약할 수 있습니다
            </div>
          )}
        </div>,
        document.body
      )}

      {/* 변환(일괄 이름 변경) 모달 - 체크한 항목들의 이름을 한 번에 바꾼다.
          목록은 300px 넘으면 스크롤, 지우기/추가로 미리보기 이름을 만들고 적용으로 확정한다. */}
      {convertModalOpen && (
        <>
          <div
            onClick={closeConvertModal}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0,0,0,0.45)",
              zIndex: 39,
              opacity: convertModalVisible ? 1 : 0,
              transition: "opacity 0.2s ease",
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: convertModalVisible ? "translate(-50%, -50%) scale(1)" : "translate(-50%, -50%) scale(0.92)",
              opacity: convertModalVisible ? 1 : 0,
              background: isLight ? "#FFFFFF" : "#1a1918",
              borderRadius: 20,
              border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
              padding: "32px 30px",
              width: "84vw",
              boxSizing: "border-box",
              zIndex: 40,
              boxShadow: "0 30px 60px rgba(0,0,0,0.55)",
              transition: "opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1), transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
              <h2
                style={{
                  margin: 0,
                  fontSize: 20,
                  fontWeight: 700,
                  color: isLight ? "#14161A" : "#FFFFFF",
                }}
              >
                변환
              </h2>
              <button
                onClick={closeConvertModal}
                onMouseDown={pressDown("scale(0.85)")}
                onMouseUp={pressUp("scale(1)")}
                aria-label="닫기"
                style={{
                  flexShrink: 0,
                  width: 30,
                  height: 30,
                  borderRadius: 7,
                  border: "none",
                  background: "transparent",
                  color: isLight ? "rgba(20,22,26,0.55)" : "rgba(255,255,255,0.55)",
                  cursor: "pointer",
                  outline: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "background 0.2s ease, transform 0.15s ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.08)"}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.transform = "scale(1)"; }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            </div>

            <button
              onClick={toggleConvertSelectAll}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: 0,
                marginBottom: 14,
                border: "none",
                background: "transparent",
                fontSize: 13,
                fontWeight: 500,
                color: isLight ? "rgba(20,22,26,0.55)" : "rgba(255,255,255,0.62)",
                cursor: "pointer",
                outline: "none",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              전체 선택
            </button>

            <div
              style={{
                maxHeight: 300,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                marginBottom: 16,
              }}
            >
              {convertTargets.length === 0 && (
                <div
                  style={{
                    textAlign: "center",
                    padding: "20px 0",
                    color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.45)",
                    fontSize: 14,
                  }}
                >
                  변환할 항목이 없습니다
                </div>
              )}
              {convertTargets.map((item) => {
                const displayName = convertDrafts[item.id] !== undefined ? convertDrafts[item.id] : item.name;
                return (
                  <label
                    key={item.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 4px",
                      cursor: "pointer",
                      borderRadius: 8,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!convertChecked[item.id]}
                      onChange={() => toggleConvertChecked(item.id)}
                      style={{ width: 18, height: 18, flexShrink: 0, cursor: "pointer" }}
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 15,
                        color: displayName
                          ? (isLight ? "#14161A" : "#FFFFFF")
                          : (isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.35)"),
                      }}
                    >
                      {displayName || "(빈 이름)"}
                    </span>
                  </label>
                );
              })}
            </div>

            <input
              type="text"
              value={convertInput}
              onChange={(e) => setConvertInput(e.target.value)}
              placeholder="여기에 입력하세요"
              style={{
                width: "100%",
                padding: 12,
                marginBottom: 12,
                border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                borderRadius: 8,
                background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                color: isLight ? "#14161A" : "#FFFFFF",
                fontSize: 15,
                outline: "none",
                boxSizing: "border-box",
                transition: "border-color 0.2s ease",
              }}
            />

            <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
              <button
                onClick={handleConvertClear}
                onMouseDown={pressDown("scale(0.95)")}
                onMouseUp={pressUp("scale(1)")}
                style={{
                  flex: 1,
                  padding: 10,
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                  borderRadius: 8,
                  background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                  color: isLight ? "#14161A" : "#FFFFFF",
                  fontSize: 15,
                  fontWeight: 500,
                  cursor: "pointer",
                  outline: "none",
                  transition: "background 0.2s ease, transform 0.15s ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.1)"}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)";
                  e.currentTarget.style.transform = "scale(1)";
                }}
              >
                삭제
              </button>
              <button
                onClick={handleConvertAppend}
                onMouseDown={pressDown("scale(0.95)")}
                onMouseUp={pressUp("scale(1)")}
                style={{
                  flex: 1,
                  padding: 10,
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                  borderRadius: 8,
                  background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                  color: isLight ? "#14161A" : "#FFFFFF",
                  fontSize: 15,
                  fontWeight: 500,
                  cursor: "pointer",
                  outline: "none",
                  transition: "background 0.2s ease, transform 0.15s ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.1)"}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)";
                  e.currentTarget.style.transform = "scale(1)";
                }}
              >
                추가
              </button>
            </div>

            <button
              onClick={handleConvertApply}
              onMouseDown={pressDown("scale(0.95)")}
              onMouseUp={pressUp("scale(1)")}
              style={{
                width: "100%",
                padding: 10,
                border: "none",
                borderRadius: 8,
                background: isLight ? "#14161A" : "#FFFFFF",
                color: isLight ? "#FFFFFF" : "#14161A",
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
                outline: "none",
                transition: "transform 0.15s ease",
              }}
              onMouseEnter={(e) => e.currentTarget.style.transform = "translateY(-1px)"}
              onMouseLeave={(e) => e.currentTarget.style.transform = "translateY(0)"}
            >
              적용
            </button>
          </div>
        </>
      )}

      {/* 태그 모달 - 변환 모달과 동일한 레이아웃. 체크한 항목들에 "#태그"를 붙이거나 뗀다. */}
      {tagModalOpen && (
        <>
          <div
            onClick={closeTagModal}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0,0,0,0.45)",
              zIndex: 39,
              opacity: tagModalVisible ? 1 : 0,
              transition: "opacity 0.2s ease",
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: tagModalVisible ? "translate(-50%, -50%) scale(1)" : "translate(-50%, -50%) scale(0.92)",
              opacity: tagModalVisible ? 1 : 0,
              background: isLight ? "#FFFFFF" : "#1a1918",
              borderRadius: 20,
              border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
              padding: "32px 30px",
              width: "84vw",
              boxSizing: "border-box",
              zIndex: 40,
              boxShadow: "0 30px 60px rgba(0,0,0,0.55)",
              transition: "opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1), transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
              <h2
                style={{
                  margin: 0,
                  fontSize: 20,
                  fontWeight: 700,
                  color: isLight ? "#14161A" : "#FFFFFF",
                }}
              >
                태그
              </h2>
              <button
                onClick={closeTagModal}
                onMouseDown={pressDown("scale(0.85)")}
                onMouseUp={pressUp("scale(1)")}
                aria-label="닫기"
                style={{
                  flexShrink: 0,
                  width: 30,
                  height: 30,
                  borderRadius: 7,
                  border: "none",
                  background: "transparent",
                  color: isLight ? "rgba(20,22,26,0.55)" : "rgba(255,255,255,0.55)",
                  cursor: "pointer",
                  outline: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "background 0.2s ease, transform 0.15s ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.08)"}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.transform = "scale(1)"; }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            </div>

            <button
              onClick={toggleTagSelectAll}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: 0,
                marginBottom: 14,
                border: "none",
                background: "transparent",
                fontSize: 13,
                fontWeight: 500,
                color: isLight ? "rgba(20,22,26,0.55)" : "rgba(255,255,255,0.62)",
                cursor: "pointer",
                outline: "none",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              전체 선택
            </button>

            {/* 지정할 데이터 - 체크한 항목에 태그가 적용된다. 각 항목의 현재 미리보기 태그도 함께 보여준다. */}
            <div
              style={{
                maxHeight: 300,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                marginBottom: 16,
              }}
            >
              {tagTargets.length === 0 && (
                <div
                  style={{
                    textAlign: "center",
                    padding: "20px 0",
                    color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.45)",
                    fontSize: 14,
                  }}
                >
                  태그를 지정할 항목이 없습니다
                </div>
              )}
              {tagTargets.map((item) => {
                const draftTags = tagDrafts[item.id] !== undefined ? tagDrafts[item.id] : item.tags;
                return (
                  <label
                    key={item.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "8px 4px",
                      cursor: "pointer",
                      borderRadius: 8,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!tagChecked[item.id]}
                      onChange={() => toggleTagChecked(item.id)}
                      style={{ width: 18, height: 18, flexShrink: 0, cursor: "pointer", marginTop: 1 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontSize: 15,
                          color: isLight ? "#14161A" : "#FFFFFF",
                        }}
                      >
                        {item.name}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          marginTop: 2,
                          color: draftTags.length
                            ? (isLight ? "rgba(20,22,26,0.5)" : "rgba(255,255,255,0.5)")
                            : (isLight ? "rgba(20,22,26,0.3)" : "rgba(255,255,255,0.3)"),
                        }}
                      >
                        {draftTags.length ? draftTags.join(" ") : "(태그 없음)"}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="여기에 입력하세요"
              style={{
                width: "100%",
                padding: 12,
                marginBottom: 12,
                border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                borderRadius: 8,
                background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                color: isLight ? "#14161A" : "#FFFFFF",
                fontSize: 15,
                outline: "none",
                boxSizing: "border-box",
                transition: "border-color 0.2s ease",
              }}
            />

            <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
              <button
                onClick={handleTagClear}
                onMouseDown={pressDown("scale(0.95)")}
                onMouseUp={pressUp("scale(1)")}
                style={{
                  flex: 1,
                  padding: 10,
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                  borderRadius: 8,
                  background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                  color: isLight ? "#14161A" : "#FFFFFF",
                  fontSize: 15,
                  fontWeight: 500,
                  cursor: "pointer",
                  outline: "none",
                  transition: "background 0.2s ease, transform 0.15s ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.1)"}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)";
                  e.currentTarget.style.transform = "scale(1)";
                }}
              >
                삭제
              </button>
              <button
                onClick={handleTagAppend}
                onMouseDown={pressDown("scale(0.95)")}
                onMouseUp={pressUp("scale(1)")}
                style={{
                  flex: 1,
                  padding: 10,
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                  borderRadius: 8,
                  background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                  color: isLight ? "#14161A" : "#FFFFFF",
                  fontSize: 15,
                  fontWeight: 500,
                  cursor: "pointer",
                  outline: "none",
                  transition: "background 0.2s ease, transform 0.15s ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.1)"}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)";
                  e.currentTarget.style.transform = "scale(1)";
                }}
              >
                추가
              </button>
            </div>

            <button
              onClick={handleTagApply}
              onMouseDown={pressDown("scale(0.95)")}
              onMouseUp={pressUp("scale(1)")}
              style={{
                width: "100%",
                padding: 10,
                border: "none",
                borderRadius: 8,
                background: isLight ? "#14161A" : "#FFFFFF",
                color: isLight ? "#FFFFFF" : "#14161A",
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
                outline: "none",
                transition: "transform 0.15s ease",
              }}
              onMouseEnter={(e) => e.currentTarget.style.transform = "translateY(-1px)"}
              onMouseLeave={(e) => e.currentTarget.style.transform = "translateY(0)"}
            >
              적용
            </button>
          </div>
        </>
      )}

      {/* 이미지/움짤 전체화면 뷰어 - 배경 페이드로 열리고, 좌우 드래그(스와이프)로
          같은 목록 안의 이전/다음 사진으로 넘어간다. 우측 상단 리퀴드 글래스 X로 닫는다. */}
      {viewerOpen && (
        <>
          <div
            onPointerDown={viewerPointerDown}
            onPointerMove={viewerPointerMove}
            onPointerUp={viewerPointerUp}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0,0,0,0.92)",
              zIndex: 49,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              opacity: viewerVisible ? 1 : 0,
              transition: "opacity 0.25s ease",
              touchAction: "none",
            }}
          >
            {viewerImages[viewerIndex] && viewerImages[viewerIndex].url && (
              <img
                key={viewerImages[viewerIndex].id}
                src={viewerImages[viewerIndex].url}
                alt={viewerImages[viewerIndex].name}
                draggable={false}
                onClick={(e) => e.stopPropagation()}
                style={{
                  maxWidth: "92vw",
                  maxHeight: "85vh",
                  objectFit: "contain",
                  borderRadius: 12,
                  transform: `translateX(${viewerDragX}px)`,
                  transition: viewerAnimating ? "transform 0.22s cubic-bezier(0.22, 1, 0.36, 1)" : "none",
                }}
              />
            )}
          </div>
          <button
            onClick={closeViewer}
            onMouseDown={pressDown("scale(0.9)")}
            onMouseUp={pressUp("scale(1)")}
            aria-label="닫기"
            style={{
              position: "fixed",
              top: 20,
              right: 20,
              zIndex: 50,
              width: 44,
              height: 44,
              borderRadius: "50%",
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(255,255,255,0.12)",
              backdropFilter: "blur(20px) saturate(180%)",
              WebkitBackdropFilter: "blur(20px) saturate(180%)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.15)",
              color: "#FFFFFF",
              cursor: "pointer",
              outline: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: viewerVisible ? 1 : 0,
              transition: "opacity 0.25s ease, transform 0.15s ease",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </>
      )}

    </div>
  );
}
