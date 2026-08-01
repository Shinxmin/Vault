import React, { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./supabaseClient";

// 앱 버전 표기 - v0.1.N, N은 현재까지 main에 병합된 PR(변경 라운드) 번호.
const APP_VERSION = "0.1.80";

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

  // Vaulty 데이터 모델: Vault(프로젝트) > Folder(폴더) > Data(이미지/문서)
  //  - vaults: 홈 화면에 카드로 보이는 최상위 프로젝트 [{id, name}]
  //  - folders: path[0]가 소속 Vault 이름이며 path 는 자기 이름까지 포함
  //  - files: path 는 소속 디렉터리(= Vault 이름 포함). kind 는 'image' | 'doc'
  //    · 이미지/움짤(JPG/JPEG/PNG/GIF/APNG/WEBP)과 텍스트(TXT)만 업로드 가능
  //    · 문서(doc)는 Vault 바로 아래(path.length === 1)에서만 생성/보관 가능
  const [currentPath, setCurrentPath] = useState([]); // [] = 홈(Vault 목록)
  const [vaults, setVaults] = useState([]);
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
  // 사용자 지정(꾹 눌러서 드래그) 정렬을 사용하면 배열 자체의 순서를 그대로 쓴다.
  // customOrderActive는 아래 load/save 이펙트의 의존성 배열에서 참조하므로 그보다 먼저
  // 선언해야 한다(안 그러면 TDZ로 "Cannot access before initialization" 런타임 에러가 난다).
  const SORT_MODES = ["ko", "num", "en"];
  const [sortModeIndex, setSortModeIndex] = useState(0);
  const [customOrderActive, setCustomOrderActive] = useState(false);
  // storageLimitGB도 같은 이유로 여기서 미리 선언한다(저장 공간 한도, 기본 10GB).
  const [storageLimitGB, setStorageLimitGB] = useState(10);
  // 업로드 방식 - 설정 탭의 "업로드" 카드에서 원본/최적화 스위치로 고른다. 최적화면
  // 이미지/움짤만 원본 해상도의 50%로 줄여서 올린다(기본값은 원본 - 손대지 않고 그대로 올림).
  const [uploadOptimizeEnabled, setUploadOptimizeEnabled] = useState(false);
  // 로그인 - 개인 웹사이트라 회원가입 기능은 없고, Supabase Auth에 미리 등록해 둔
  // 계정(들)으로만 로그인할 수 있다(가입 화면이 없으니 등록 안 된 계정은 애초에
  // signInWithPassword 자체가 실패한다). vaulty_state.user_id가 그 계정의 Vault
  // 데이터가 들어있는 행을 가리킨다. 비로그인 상태에서는 Vault/폴더/파일 등은 전혀
  // 불러오지 않고(웹드라이브 이용 불가), 게시글만 항상 공개된 'default' 행에서 읽는다.
  const [authUser, setAuthUser] = useState(null); // { id, username } | null
  const [authLoading, setAuthLoading] = useState(true);
  const [myRowId, setMyRowId] = useState("default"); // 로그인 계정의 vaulty_state 행 id
  const [authIdDraft, setAuthIdDraft] = useState("");
  const [authPasswordDraft, setAuthPasswordDraft] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const sortMode = customOrderActive ? "custom" : SORT_MODES[sortModeIndex];
  const cycleSortMode = () => {
    setCustomOrderActive(false);
    setSortModeIndex((i) => (i + 1) % SORT_MODES.length);
  };

  // 예전에 만든 항목은 createdAt/updatedAt 없이 저장돼 있을 수 있는데(이 필드를 넣기 전
  // 버전에서 생성됨), id 자체가 Date.now() 기반 타임스탬프라 생성 시각의 대체값으로 쓸 수
  // 있다. "정보" 모달에 빈 값이 뜨지 않도록 불러올 때 항상 유효한 날짜를 채워 넣는다.
  const withDates = (item) => {
    const createdAt = item.createdAt || Math.floor(item.id);
    return { ...item, createdAt, updatedAt: item.updatedAt || createdAt };
  };

  // Vaulty 상태(Vault/폴더/파일 목록) 영구 저장 - 계정별로 vaulty_state의 한 행(row)에
  // 저장한다. 파일의 실제 바이트는 R2에 있고 files[].r2Key로 R2 객체를 가리킨다.
  const [dataLoaded, setDataLoaded] = useState(false);
  // 휴지통 - 삭제된 Vault/폴더/파일(이미지)은 바로 지워지지 않고 여기 담겨 7일간
  // 보관된다. trash 컬럼은 이후에 추가된 것이라 아직 마이그레이션을 안 돌린 환경에서는
  // 없을 수 있으므로, select("*")로 있으면 읽고 없으면 빈 배열로 취급한다.
  const [trash, setTrash] = useState([]);
  const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  // vaulty_state 한 행을 상태로 반영하는 공용 유틸 - 최초 비로그인 로드와 로그인 직후
  // 둘 다 이 함수를 쓴다. 이미지 표시용 url은 만료되는 presigned URL이라 DB에 저장하지
  // 않으므로 불러올 때마다 r2Key 기준으로 새로 발급받는다(휴지통 안 이미지도 포함).
  const hydrateFromRow = async (row) => {
    const loadedVaults = (row.vaults || []).map(withDates);
    const loadedFolders = (row.folders || []).map(withDates);
    const loadedFiles = (row.files || []).map(withDates);
    const loadedTrash = row.trash || [];
    setVaults(loadedVaults);
    setFolders(loadedFolders);
    setCustomOrderActive(row.custom_order_active === true);
    setStorageLimitGB(typeof row.storage_limit_gb === "number" && row.storage_limit_gb > 0 ? row.storage_limit_gb : 10);
    setUploadOptimizeEnabled(row.upload_optimize_enabled === true);
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

  // 로그인 세션을 실제 앱 상태로 반영한다 - 이 계정의 vaulty_state 행을 찾아 Vault
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

  // 로그아웃/비로그인 상태로 되돌린다 - Vault 데이터는 화면에서 완전히 사라진다.
  const clearMyData = () => {
    setAuthUser(null);
    setMyRowId("default");
    setVaults([]);
    setFolders([]);
    setFiles([]);
    setTrash([]);
    setCustomOrderActive(false);
    setStorageLimitGB(10);
    setUploadOptimizeEnabled(false);
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

  // 초기 로드가 끝난 뒤부터 vaults/folders/files/customOrderActive가 바뀔 때마다 살짝
  // 지연을 두고(짧은 시간 내 연속 변경을 한 번으로 묶어) Supabase에 저장한다. 로그인
  // 상태가 아니면 애초에 보여줄 Vault 데이터가 없으므로(웹드라이브는 로그인 전용) 절대
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
          vaults,
          folders,
          files: filesToSave,
          custom_order_active: customOrderActive,
          storage_limit_gb: storageLimitGB,
          upload_optimize_enabled: uploadOptimizeEnabled,
          updated_at: new Date().toISOString(),
        })
        .then(({ error }) => {
          if (error) {
            // 저장이 실패하면(예: 컬럼 스키마가 아직 반영되지 않은 경우) 콘솔 로그만으로는
            // 사용자가 알아챌 방법이 없어 새로고침하면 변경 내용이 통째로 사라진 것처럼
            // 보인다 - 눈에 보이는 안내를 반드시 함께 띄운다.
            console.error("Vaulty 상태 저장 실패:", error);
            showToast("저장에 실패했습니다. 새로고침하지 마세요");
          }
        });
    }, 800);
    return () => clearTimeout(saveTimerRef.current);
  }, [vaults, folders, files, customOrderActive, storageLimitGB, uploadOptimizeEnabled, dataLoaded, authUser, myRowId]);

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

  // Vault 생성 모달
  const [vaultModalOpen, setVaultModalOpen] = useState(false);
  const [vaultModalVisible, setVaultModalVisible] = useState(false);
  const [vaultNameInput, setVaultNameInput] = useState("");

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
  // 버튼을 한 번 더 누르면 그때 실제로 삭제된다. Vault/폴더/파일(이미지) 전부 공용.
  const [deleteArmedKey, setDeleteArmedKey] = useState(null); // `${type}-${id}`
  const galleryInputRef = useRef(null);


  // 설정 화면 - 상단 우측 설정(⚙) 버튼을 누르면 전체화면으로 열린다. 그 안에서 휴지통은
  // 화면을 하나 더 미는 방식(별도 탭이 아니라 이 설정 화면 안의 하위 화면).
  const [settingsScreenOpen, setSettingsScreenOpen] = useState(false);
  const [settingsButtonHovered, setSettingsButtonHovered] = useState(false);
  const [trashScreenOpen, setTrashScreenOpen] = useState(false);
  // 요금 안내 - 청구 금액 제목 오른쪽의 물음표 아이콘을 누르면 하단 서브 액션바와 같은
  // 리퀴드 글래스 배경을 가진 별도의 뜬 패널이 그 아이콘 바로 밑 위치에 2초간 페이드
  // 인/아웃으로 떴다가 사라진다(레이아웃 흐름에 얹혀 다른 내용을 밀어내지 않고,
  // document.body에 포탈로 띄운다). 떠 있는 동안에는 물음표 버튼을 비활성화하고 투명도를 낮춘다.
  const [pricingInfoOpen, setPricingInfoOpen] = useState(false);
  const [pricingInfoVisible, setPricingInfoVisible] = useState(false);
  const [pricingInfoPos, setPricingInfoPos] = useState({ top: 0, left: 0 });
  const pricingButtonRef = useRef(null);
  const pricingInfoShowTimerRef = useRef(null);
  const pricingInfoHideTimerRef = useRef(null);
  const showPricingInfo = () => {
    if (pricingInfoShowTimerRef.current) clearTimeout(pricingInfoShowTimerRef.current);
    if (pricingInfoHideTimerRef.current) clearTimeout(pricingInfoHideTimerRef.current);
    if (pricingButtonRef.current) {
      const rect = pricingButtonRef.current.getBoundingClientRect();
      setPricingInfoPos({ top: rect.bottom + 8, left: rect.left });
    }
    setPricingInfoOpen(true);
    requestAnimationFrame(() => setPricingInfoVisible(true));
    pricingInfoHideTimerRef.current = setTimeout(() => {
      setPricingInfoVisible(false);
      pricingInfoShowTimerRef.current = setTimeout(() => setPricingInfoOpen(false), 300);
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

  // 예상 청구 금액 - 한도가 아니라 실제 지금 사용 중인 용량 기준으로, 기본 10GB를
  // 초과한 만큼만 GB당 $0.015를 곱한다.
  const usedStorageGB = usedStorageBytes / (1024 * 1024 * 1024);
  const billingOverageGB = Math.max(0, usedStorageGB - 10);
  const billingAmount = billingOverageGB * 0.015;

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
  // 그 위(Vault 홈)로 튕겨나가는 버그가 생긴다.
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

  // Vault 생성 모달 - 홈에서 + 버튼을 누르면 열린다.
  const openVaultModal = () => {
    setVaultModalOpen(true);
    requestAnimationFrame(() => setVaultModalVisible(true));
  };
  const closeVaultModal = () => {
    setVaultModalVisible(false);
    setTimeout(() => {
      setVaultModalOpen(false);
      setVaultNameInput("");
    }, 200);
  };
  const createVault = () => {
    if (vaultNameInput.trim()) {
      const now = Date.now();
      const trimmedName = vaultNameInput.trim();
      setVaults((prev) => [...prev, { id: now, name: trimmedName, createdAt: now, updatedAt: now }]);
    }
    closeVaultModal();
  };
  // 삭제 = 휴지통으로 이동. Vault를 지우면 그 안의 폴더/파일도 통째로 하나의 휴지통
  // 항목으로 담아서, "복구"를 누르면 원래 구조 그대로 되돌아온다.
  const deleteVault = (vaultId) => {
    const vault = vaults.find((v) => v.id === vaultId);
    if (!vault) { closeItemMenu(); return; }
    const descFolders = folders.filter((f) => f.path[0] === vault.name);
    const descFiles = files.filter((f) => f.path[0] === vault.name);
    setTrash((prev) => [...prev, {
      id: Date.now(),
      type: "vault",
      name: vault.name,
      deletedAt: Date.now(),
      vault,
      folders: descFolders,
      files: descFiles,
    }]);
    setVaults((prev) => prev.filter((v) => v.id !== vaultId));
    setFolders((prev) => prev.filter((f) => f.path[0] !== vault.name));
    setFiles((prev) => prev.filter((f) => f.path[0] !== vault.name));
    closeItemMenu();
    showToast("데이터를 삭제했습니다");
  };

  // 홈에서는 + 가 Vault 생성 모달을, Vault/폴더 안에서는 업로드 메뉴를 연다.
  const handleAddButton = () => {
    if (currentPath.length === 0) openVaultModal();
    else toggleUploadMenu();
  };

  const openItemMenu = (type, id, anchorEl) => {
    if (anchorEl) {
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
  // 사용자 지정(꾹 눌러서 드래그) 정렬을 사용하면 배열 자체의 순서를 그대로 쓴다.
  // localeCompare에 { numeric: true }를 줘서 이름 안에 섞인 숫자를 문자 하나씩이 아니라
  // 값 그대로 비교한다 - 안 그러면 "예시(10)"이 "예시(2)"보다 앞에 온다("1" < "2"라서).
  // 이 옵션을 주면 "예시(1)", "예시(2)", ..., "예시(9)", "예시(10)" 순서로 정렬된다.
  // 고정된 항목(pinned)은 정렬 모드/사용자 지정 순서와 무관하게 항상 맨 위에 먼저 온다 -
  // 여러 개면 그 안에서도(사용자 지정 모드에서는 가나다/숫자/알파벳 정렬 기준으로) 순서대로 배치된다.
  const sortItems = (items) => {
    const comparator =
      sortMode === "num"
        ? (a, b) => {
            const na = parseFloat(a.name);
            const nb = parseFloat(b.name);
            const aIsNum = !isNaN(na);
            const bIsNum = !isNaN(nb);
            if (aIsNum && bIsNum) return na - nb;
            if (aIsNum) return -1;
            if (bIsNum) return 1;
            return a.name.localeCompare(b.name, "en", { numeric: true });
          }
        : sortMode === "en"
        ? (a, b) => a.name.localeCompare(b.name, "en", { numeric: true })
        : (a, b) => a.name.localeCompare(b.name, "ko", { numeric: true });
    const pinned = items.filter((i) => i.pinned).sort(comparator);
    const rest = items.filter((i) => !i.pinned);
    if (sortMode === "custom") return [...pinned, ...rest];
    return [...pinned, ...rest.sort(comparator)];
  };

  // 검색 결과/"분류" 화면 전용 정렬 - 현재 정렬 모드(사용자 지정 드래그 순서 포함)와 무관하게
  // 항상 가나다순으로 보여준다(폴더는 별도 섹션으로 이미지보다 먼저 렌더링되어 항상 최상단에 온다).
  // sortItems와 마찬가지로 숫자는 값 그대로 비교한다.
  const koSort = (items) => [...items].sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true }));

  // 폴더/문서 꾹 눌러서 드래그로 섹션 내 순서 변경(사용자 지정 정렬)
  const [draggingItem, setDraggingItem] = useState(null); // { type: 'folder' | 'file', id }
  const [dragOverKey, setDragOverKey] = useState(null);
  const draggingItemRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const longPressStartRef = useRef(null);
  const justDraggedRef = useRef(false);
  const dragScrollLockRef = useRef(null); // 드래그 시작 시점의 스크롤 위치 - 드래그 중 스크롤 밀림 방지용

  useEffect(() => {
    draggingItemRef.current = draggingItem;
  }, [draggingItem]);

  const reorderItem = (type, draggedId, targetId) => {
    const setter = type === "folder" ? setFolders : type === "file" ? setFiles : setVaults;
    setter((prev) => {
      const list = [...prev];
      const fromIndex = list.findIndex((it) => it.id === draggedId);
      const toIndex = list.findIndex((it) => it.id === targetId);
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return prev;
      const [moved] = list.splice(fromIndex, 1);
      list.splice(toIndex, 0, moved);
      return list;
    });
  };

  const handleDragPointerMove = (e) => {
    const current = draggingItemRef.current;
    if (!current) return;
    // 드래그 중에는 화면이 같이 스크롤되면 목표 위치가 계속 움직여서 정렬하기 어려우므로,
    // 스크롤이 밀리기 전에 막는다(터치 스크롤 기본 동작 억제 + 스크롤 위치 고정 둘 다).
    e.preventDefault();
    if (dragScrollLockRef.current !== null) {
      if (window.scrollY !== dragScrollLockRef.current) window.scrollTo(0, dragScrollLockRef.current);
    }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const targetEl = el && el.closest("[data-drag-type]");
    if (!targetEl) return;
    const targetType = targetEl.getAttribute("data-drag-type");
    const targetId = parseFloat(targetEl.getAttribute("data-drag-id"));
    if (targetType !== current.type || targetId === current.id) return;
    setDragOverKey(`${targetType}-${targetId}`);
    reorderItem(current.type, current.id, targetId);
  };

  const handleDragPointerUp = () => {
    setDraggingItem(null);
    setDragOverKey(null);
    setCustomOrderActive(true);
    justDraggedRef.current = true;
    dragScrollLockRef.current = null;
    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";
    setTimeout(() => {
      justDraggedRef.current = false;
    }, 80);
    window.removeEventListener("pointermove", handleDragPointerMove);
    window.removeEventListener("pointerup", handleDragPointerUp);
  };

  const beginDrag = (type, id) => {
    setDraggingItem({ type, id });
    dragScrollLockRef.current = window.scrollY;
    // body/html에 overflow:hidden을 주면 대부분의 브라우저에서 드래그 중 스크롤이 막힌다.
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    window.addEventListener("pointermove", handleDragPointerMove, { passive: false });
    window.addEventListener("pointerup", handleDragPointerUp);
  };

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const rowPointerDown = (type, id) => (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    longPressStartRef.current = { x: e.clientX, y: e.clientY };
    clearLongPressTimer();
    longPressTimerRef.current = setTimeout(() => {
      beginDrag(type, id);
    }, 450);
  };
  const rowPointerMove = (e) => {
    if (!longPressStartRef.current || draggingItemRef.current) return;
    const dx = e.clientX - longPressStartRef.current.x;
    const dy = e.clientY - longPressStartRef.current.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearLongPressTimer();
  };
  const rowPointerUp = () => clearLongPressTimer();

  // 이름 바꾸기 - 별도 모달 없이, 현재 화면에서 해당 항목의 제목 텍스트를 인라인 입력창으로
  // 바꿔서 바로 수정한다. 입력 후 포커스를 벗어나면(blur) 자동으로 저장된다.
  const [editingItem, setEditingItem] = useState(null); // { type: 'vault' | 'folder' | 'file', id }
  const [editingValue, setEditingValue] = useState("");

  const startInlineEdit = (type, id, currentName) => {
    setEditingItem({ type, id });
    setEditingValue(currentName);
  };
  // path가 prefix로 시작하는지, 그리고 그 prefix를 다른 prefix로 바꿔치기하는 헬퍼.
  // Vault나 폴더 이름을 바꿀 때 그 하위의 모든 폴더/파일 path를 갱신하는 데 공용으로 쓴다
  // (깊이에 상관없이 동작 - 예전에는 폴더 이름을 바꾸면 하위 이미지의 path가 갱신되지 않아
  // 화면에서 사라지는 버그가 있었다).
  const pathStartsWith = (path, prefix) =>
    path.length >= prefix.length && prefix.every((seg, i) => path[i] === seg);
  const rebasePath = (path, oldPrefix, newPrefix) => [...newPrefix, ...path.slice(oldPrefix.length)];

  const commitInlineEdit = () => {
    if (!editingItem) return;
    const newName = editingValue.trim();
    if (newName) {
      if (editingItem.type === "vault") {
        const vault = vaults.find((v) => v.id === editingItem.id);
        setVaults((prev) => prev.map((v) => (v.id === editingItem.id ? { ...v, name: newName, updatedAt: Date.now() } : v)));
        if (vault && vault.name !== newName) {
          const oldPrefix = [vault.name];
          const newPrefix = [newName];
          setFolders((prev) => prev.map((f) => (pathStartsWith(f.path, oldPrefix) ? { ...f, path: rebasePath(f.path, oldPrefix, newPrefix) } : f)));
          setFiles((prev) => prev.map((f) => (pathStartsWith(f.path, oldPrefix) ? { ...f, path: rebasePath(f.path, oldPrefix, newPrefix) } : f)));
        }
      } else if (editingItem.type === "folder") {
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

  // 변환(일괄 이름 변경) 모달 - "마법사" 메뉴의 "변환"을 누르면 뜬다. 홈에서는 Vault들을,
  // 폴더/Vault 안에서는 그 안의 하위 폴더·파일·이미지들을 체크해서 한 번에 새 이름으로 바꾼다.
  const [convertModalOpen, setConvertModalOpen] = useState(false);
  const [convertModalVisible, setConvertModalVisible] = useState(false);
  const [convertChecked, setConvertChecked] = useState({}); // { [id]: true }
  const [convertDrafts, setConvertDrafts] = useState({}); // { [id]: 미리보기용 새 이름 }
  const [convertInput, setConvertInput] = useState("");

  const convertTargets = useMemo(() => {
    const items = currentPath.length === 0
      ? vaults.map((v) => ({ id: v.id, name: v.name, type: "vault" }))
      : [
          ...folders
            .filter((f) => f.path.length === currentPath.length + 1 && f.path.slice(0, currentPath.length).every((p, i) => p === currentPath[i]))
            .map((f) => ({ id: f.id, name: f.name, type: "folder" })),
          ...files
            .filter((f) => f.path.length === currentPath.length && f.path.every((p, i) => p === currentPath[i]))
            .map((f) => ({ id: f.id, name: f.name, type: "file" })),
        ];
    // 변환/태그 모달의 대상 목록은 항상 ㄱㄴㄷ(가나다)순으로 보여준다.
    return items.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [currentPath, vaults, folders, files]);

  const openConvertModal = () => {
    setConvertChecked({});
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
    if (currentPath.length === 0) {
      const vaultRenames = resolved
        .map((r) => {
          const v = vaults.find((vv) => vv.id === r.id);
          return v && v.name !== r.name ? { oldName: v.name, newName: r.name } : null;
        })
        .filter(Boolean);
      setVaults((prev) => prev.map((v) => (nameById[v.id] ? { ...v, name: nameById[v.id], updatedAt: now } : v)));
      vaultRenames.forEach(({ oldName, newName }) => {
        const oldPrefix = [oldName];
        const newPrefix = [newName];
        setFolders((prev) => prev.map((f) => (pathStartsWith(f.path, oldPrefix) ? { ...f, path: rebasePath(f.path, oldPrefix, newPrefix) } : f)));
        setFiles((prev) => prev.map((f) => (pathStartsWith(f.path, oldPrefix) ? { ...f, path: rebasePath(f.path, oldPrefix, newPrefix) } : f)));
      });
    } else {
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

  const tagTargets = useMemo(() => convertTargets.map((t) => {
    const source =
      t.type === "vault" ? vaults.find((v) => v.id === t.id) :
      t.type === "folder" ? folders.find((f) => f.id === t.id) :
      files.find((f) => f.id === t.id);
    return { ...t, tags: (source && source.tags) || [] };
  }), [convertTargets, vaults, folders, files]);

  const openTagModal = () => {
    setTagChecked({});
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
  // 적용 - 실제로 vaults/folders/files에 태그 배열을 반영한다.
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
    if (currentPath.length === 0) {
      setVaults((prev) => prev.map((v) => (tagsById[v.id] !== undefined ? { ...v, tags: tagsById[v.id], updatedAt: now } : v)));
    } else {
      const checkedFolderIds = checkedItems.filter((i) => i.type === "folder").map((i) => i.id);
      const checkedFileIds = checkedItems.filter((i) => i.type === "file").map((i) => i.id);
      if (checkedFolderIds.length) setFolders((prev) => prev.map((f) => (checkedFolderIds.includes(f.id) ? { ...f, tags: tagsById[f.id], updatedAt: now } : f)));
      if (checkedFileIds.length) setFiles((prev) => prev.map((f) => (checkedFileIds.includes(f.id) ? { ...f, tags: tagsById[f.id], updatedAt: now } : f)));
    }
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

  // 고정 모달 - "마법사" 메뉴의 "고정"을 누르면 뜬다. 레이아웃은 변환/태그 모달과 동일하되
  // 이름/태그 편집 없이 체크박스만으로 고정 여부를 정한다(Vault는 대상에서 제외 - 폴더/파일만 고정 가능).
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pinChecked, setPinChecked] = useState({}); // { [id]: true } - 적용 시 최종 고정 여부

  const pinTargets = useMemo(() => convertTargets.filter((t) => t.type !== "vault"), [convertTargets]);

  const openPinModal = () => {
    const initial = {};
    pinTargets.forEach((item) => {
      const source = item.type === "folder" ? folders.find((f) => f.id === item.id) : files.find((f) => f.id === item.id);
      if (source && source.pinned) initial[item.id] = true;
    });
    setPinChecked(initial);
    setPinModalOpen(true);
    requestAnimationFrame(() => setPinModalVisible(true));
  };
  const closePinModal = () => {
    setPinModalVisible(false);
    setTimeout(() => setPinModalOpen(false), 200);
  };
  const togglePinChecked = (id) => {
    setPinChecked((prev) => ({ ...prev, [id]: !prev[id] }));
  };
  // 전체 선택 - 이미 전부 체크돼 있으면 전체 해제, 아니면 전체 선택으로 토글한다.
  const togglePinSelectAll = () => {
    const allChecked = pinTargets.length > 0 && pinTargets.every((item) => pinChecked[item.id]);
    setPinChecked(allChecked ? {} : Object.fromEntries(pinTargets.map((item) => [item.id, true])));
  };
  // 적용 - 체크된 항목은 고정하고, 목록에 있는데 체크 해제된 항목은 고정을 해제한다.
  const handlePinApply = () => {
    if (!pinTargets.length) {
      closePinModal();
      return;
    }
    const now = Date.now();
    const folderIds = pinTargets.filter((i) => i.type === "folder").map((i) => i.id);
    const fileIds = pinTargets.filter((i) => i.type === "file").map((i) => i.id);
    if (folderIds.length) setFolders((prev) => prev.map((f) => (folderIds.includes(f.id) ? { ...f, pinned: !!pinChecked[f.id], updatedAt: now } : f)));
    if (fileIds.length) setFiles((prev) => prev.map((f) => (fileIds.includes(f.id) ? { ...f, pinned: !!pinChecked[f.id], updatedAt: now } : f)));
    closePinModal();
  };

  // 고정 화면 - 마법사 왼쪽 별표 버튼을 누르면 검색/분류 화면과 같은 방식으로, 지금 어디에
  // 있든 상관없이 앱 전체에서 고정된 폴더가 먼저 리스트로, 그 아래 고정된 이미지/움짤이
  // 갤러리로, 문서는 리스트로 온다. 상단 헤더의 닫기(X)로 닫는다(분류 화면과 동일한 패턴).
  const [pinScreenOpen, setPinScreenOpen] = useState(false);
  const openPinScreen = () => {
    setTagScreenTags([]);
    setSearchQuery("");
    setPinScreenOpen(true);
  };
  const closePinScreen = () => setPinScreenOpen(false);
  const pinnedFolders = pinScreenOpen ? folders.filter((f) => f.pinned) : [];
  const pinnedFiles = pinScreenOpen ? files.filter((f) => f.pinned) : [];
  const pinnedDocs = pinnedFiles.filter((f) => f.kind !== "image");
  const pinnedImages = pinnedFiles.filter((f) => f.kind === "image");

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
  const movingIsDoc = movingFile && (movingFile.kind === "doc" || movingFile.kind === "text");
  const isBlockedMoveFolder = (folder) => {
    if (!movingFolder) return false;
    if (folder.id === movingFolder.id) return true;
    return (
      folder.path.length >= movingFolder.path.length &&
      movingFolder.path.every((seg, i) => folder.path[i] === seg)
    );
  };
  // 이동 모달의 탐색 목록: 홈(길이 0)에서는 Vault 를, 그 안에서는 폴더를 보여준다.
  // 문서(doc)는 Vault 바로 아래에만 둘 수 있으므로 Vault 안에서는 하위 폴더를 노출하지 않는다.
  const moveModalEntries = !moveModalOpen
    ? []
    : moveBrowsePath.length === 0
    ? vaults.map((v) => ({ id: v.id, name: v.name, isVault: true }))
    : movingIsDoc
    ? []
    : folders
        .filter(
          (f) =>
            f.path.length === moveBrowsePath.length + 1 &&
            f.path.slice(0, moveBrowsePath.length).every((p, i) => p === moveBrowsePath[i]) &&
            !isBlockedMoveFolder(f)
        )
        .map((f) => ({ id: f.id, name: f.name, isVault: false }));
  // "여기로 이동" 활성화 조건: 폴더/이미지는 Vault 안(길이>=1) 어디든, 문서는 Vault 루트(길이===1)만.
  const canDropHere = movingIsDoc ? moveBrowsePath.length === 1 : moveBrowsePath.length >= 1;

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

  // 복사 모달 - 이동 모달과 완전히 동일한 디자인/탐색 로직이지만, 원본은 그대로 두고
  // 지정한 위치에 새 사본을 만든다. 폴더를 복사하면 그 하위 폴더/파일도 전부 함께
  // 복사된다(새 id를 발급하고, path만 새 위치를 기준으로 다시 붙인다).
  const [copyModalOpen, setCopyModalOpen] = useState(false);
  const [copyModalVisible, setCopyModalVisible] = useState(false);
  const [copyTarget, setCopyTarget] = useState(null); // { type: 'folder' | 'file', id, name }
  const [copyBrowsePath, setCopyBrowsePath] = useState([]);

  const openCopyModal = (type, id, name) => {
    setCopyTarget({ type, id, name });
    setCopyBrowsePath([]);
    setCopyModalOpen(true);
    requestAnimationFrame(() => setCopyModalVisible(true));
  };
  const closeCopyModal = () => {
    setCopyModalVisible(false);
    setTimeout(() => {
      setCopyModalOpen(false);
      setCopyTarget(null);
      setCopyBrowsePath([]);
    }, 200);
  };

  const copyingFile = copyTarget && copyTarget.type === "file" ? files.find((f) => f.id === copyTarget.id) : null;
  const copyingIsDoc = copyingFile && (copyingFile.kind === "doc" || copyingFile.kind === "text");
  // 이동과 달리 복사는 원본이 그대로 남으므로 자기 자신/하위 폴더 안으로도 자유롭게
  // 들어가 사본을 만들 수 있다(막을 이유가 없다).
  const copyModalEntries = !copyModalOpen
    ? []
    : copyBrowsePath.length === 0
    ? vaults.map((v) => ({ id: v.id, name: v.name, isVault: true }))
    : copyingIsDoc
    ? []
    : folders
        .filter(
          (f) =>
            f.path.length === copyBrowsePath.length + 1 &&
            f.path.slice(0, copyBrowsePath.length).every((p, i) => p === copyBrowsePath[i])
        )
        .map((f) => ({ id: f.id, name: f.name, isVault: false }));
  const canCopyHere = copyingIsDoc ? copyBrowsePath.length === 1 : copyBrowsePath.length >= 1;

  const confirmCopy = () => {
    if (!copyTarget || !canCopyHere) {
      closeCopyModal();
      return;
    }
    if (copyTarget.type === "folder") {
      const folder = folders.find((f) => f.id === copyTarget.id);
      if (folder) {
        const oldPrefix = folder.path;
        const newPrefix = [...copyBrowsePath, folder.name];
        const descendantFolders = folders.filter(
          (f) => f.id !== folder.id && f.path.length > oldPrefix.length && oldPrefix.every((seg, i) => f.path[i] === seg)
        );
        const descendantFiles = files.filter(
          (f) => f.path.length >= oldPrefix.length && oldPrefix.every((seg, i) => f.path[i] === seg)
        );
        const now = Date.now();
        const newFolders = [folder, ...descendantFolders].map((f) => ({
          ...f,
          id: Date.now() + Math.random(),
          path: [...newPrefix, ...f.path.slice(oldPrefix.length)],
          createdAt: now,
          updatedAt: now,
        }));
        const newFiles = descendantFiles.map((f) => ({
          ...f,
          id: Date.now() + Math.random(),
          path: [...newPrefix, ...f.path.slice(oldPrefix.length)],
          createdAt: now,
          updatedAt: now,
        }));
        setFolders((prev) => [...prev, ...newFolders]);
        setFiles((prev) => [...prev, ...newFiles]);
      }
    } else {
      const file = files.find((f) => f.id === copyTarget.id);
      if (file) {
        const now = Date.now();
        setFiles((prev) => [...prev, { ...file, id: Date.now() + Math.random(), path: copyBrowsePath, createdAt: now, updatedAt: now }]);
      }
    }
    closeCopyModal();
    showToast("데이터를 복사했습니다");
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
  // 해상도를 percent%로 줄인다(원본 스위치면 이 함수 자체를 호출하지 않는다). 캔버스는
  // GIF/APNG를 다시 그 형식으로 인코딩할 수 없어서(브라우저 표준 API의 한계) PNG는
  // PNG로 유지하고 그 외(JPEG/GIF/APNG/WEBP)는 JPEG로 인코딩한다 - 최적화로 올린
  // 움짤은 애니메이션 없는 정지 이미지가 된다.
  const UPLOAD_OPTIMIZE_PERCENT = 50;
  const compressImageFile = (file, percent) =>
    new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = percent / 100;
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(objectUrl);
            blob ? resolve({ blob, outType }) : reject(new Error("압축 실패"));
          },
          outType,
          0.85
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("이미지를 불러오지 못했습니다"));
      };
      img.src = objectUrl;
    });

  const handleFilesPicked = async (e) => {
    const selected = Array.from(e.target.files || []);
    e.target.value = "";
    const toUpload = selected
      .map((f) => ({ file: f, kind: getKindFromName(f.name) }))
      .filter((x) => x.kind); // 미지원 형식은 건너뛴다

    if (!toUpload.length) return;

    // 이 업로드로 저장 공간 한도를 넘기면 하나도 올리지 않고 안내만 띄운다.
    const incomingBytes = toUpload.reduce((s, x) => s + x.file.size, 0);
    if (usedStorageBytes + incomingBytes > STORAGE_MAX_BYTES) {
      showToast("저장공간이 부족합니다");
      return;
    }

    // 이 업로드 배치를 시작하는 시점의 스위치 값을 그대로 고정해서 쓴다 - 업로드 도중
    // 설정 탭에서 스위치를 바꿔도 이미 시작된 배치에는 영향을 주지 않고, 그 다음 배치
    // (또는 진행 중인 배치가 끝난 뒤 새로 시작하는 업로드)부터 새 값이 적용된다.
    const optimizeThisBatch = uploadOptimizeEnabled;

    const queueItems = toUpload.map(({ file, kind }) => ({
      qid: `${Date.now()}-${Math.random()}`,
      file,
      kind,
      name: file.name,
      size: file.size,
      loaded: 0,
      status: "queued",
    }));
    setUploadQueue(queueItems.map(({ file, kind, ...rest }) => rest));
    setUploadPanelClosed(false);

    const updateItem = (qid, patch) => {
      setUploadQueue((prev) => prev.map((it) => (it.qid === qid ? { ...it, ...patch } : it)));
    };

    let cursor = 0;
    const runNext = async () => {
      const idx = cursor++;
      if (idx >= queueItems.length) return;
      const { qid, file, kind, size } = queueItems[idx];
      updateItem(qid, { status: "uploading" });
      const id = Date.now() + Math.random();
      let accepted = null;
      try {
        let uploadBlob = file;
        let uploadType = file.type;
        let uploadSize = size;
        if (kind === "image" && optimizeThisBatch) {
          const { blob, outType } = await compressImageFile(file, UPLOAD_OPTIMIZE_PERCENT);
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
        accepted = { id, name: base, ext, size: uploadSize, mimeType: uploadType, kind, r2Key, url, path: currentPath, createdAt: now, updatedAt: now };
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
      if (entry.vault) setVaults((prev) => [...prev, entry.vault]);
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

  // 휴지통 복구 - 원래 있던 자리(vaults/folders/files)로 그대로 되돌려 놓는다.
  const restoreTrashItem = (trashId) => {
    const entry = trash.find((t) => t.id === trashId);
    if (!entry) return;
    if (entry.vault) setVaults((prev) => [...prev, entry.vault]);
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

  // Vault 카드 하단에 보여줄 '35개 폴더, 140개 이미지 (35.5GB)' 형식의 통계 문구.
  const vaultStatsText = (vaultName) => {
    const folderCount = folders.filter((f) => f.path[0] === vaultName).length;
    const vaultFiles = files.filter((f) => f.path[0] === vaultName);
    const imageCount = vaultFiles.filter((f) => f.kind === "image").length;
    const totalBytes = vaultFiles.reduce((s, f) => s + (f.size || 0), 0);
    return `${folderCount}개 폴더, ${imageCount}개 이미지 (${formatFileSize(totalBytes)})`;
  };
  const vaultTotalBytes = (vaultName) =>
    files.filter((f) => f.path[0] === vaultName).reduce((s, f) => s + (f.size || 0), 0);

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
  // 보여준다. Vault/폴더/파일(이미지 포함) 공용.
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [infoModalVisible, setInfoModalVisible] = useState(false);
  const [infoTarget, setInfoTarget] = useState(null); // { type: 'vault' | 'folder' | 'file', id }

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
    : infoTarget.type === "vault"
    ? vaults.find((v) => v.id === infoTarget.id)
    : infoTarget.type === "folder"
    ? folders.find((f) => f.id === infoTarget.id)
    : files.find((f) => f.id === infoTarget.id);
  const infoItemSize =
    !infoTarget || !infoItem
      ? 0
      : infoTarget.type === "vault"
      ? vaultTotalBytes(infoItem.name)
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
            사람 아이콘 버튼(설정 화면 열기)을 둔다. 예전 + 버튼(Vault 생성/업로드 메뉴
            트리거)은 "마법사" 옆 "업로드" 버튼으로 옮겨갔다. */}
        <div style={stickyHeaderStyle}>
          {(tagScreenTags.length || pinScreenOpen) ? (
            <>
              <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: isLight ? "#14161A" : "#FFFFFF", letterSpacing: 0.2, minHeight: "1em" }}>
                {pinScreenOpen ? "고정" : "분류"}
              </h1>
              <div style={{ position: "relative" }}>
                <button
                  onClick={pinScreenOpen ? closePinScreen : closeTagScreen}
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
              <h1
                onClick={() => setCurrentPath([])}
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
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="검색"
                  aria-label="검색"
                  style={{
                    width: "66%",
                    height: TOP_BUTTON_SIZE,
                    boxSizing: "border-box",
                    padding: "0 18px",
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

        {/* 로그인 게이트 - 웹드라이브(Vault/폴더/파일)는 로그인 계정 전용 데이터라
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
            {/* 경로 표기 및 정렬/보기 방식 아이콘 영역 - "분류"/"고정" 화면에서는 마법사 버튼,
                경로 표시 텍스트, 구분선 없이 곧바로 목록만 보여준다. */}
            {!tagScreenTags.length && !pinScreenOpen && (
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
              {/* 경로 표기 */}
              <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
                <button
                  onClick={() => setCurrentPath([])}
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
                {currentPath.map((path, index) => (
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

              {/* 마법사 - 예전 ABC 정렬 버튼 자리. 누르면 "정렬"/"변환" 드롭다운이 뜬다 */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {/* 별표 - 마법사 왼쪽. 누르면 검색/분류 화면과 동일한 방식으로 앱 전체의
                    고정된 항목만 모아 보여준다(다시 누르면 닫힘). */}
                <button
                  onClick={openPinScreen}
                  onMouseDown={pressDown("scale(0.9)")}
                  onMouseUp={pressUp("scale(1)")}
                  aria-label="고정 목록"
                  title="고정 목록"
                  style={{
                    width: 30,
                    height: 30,
                    flexShrink: 0,
                    borderRadius: 8,
                    border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                    background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                    color: isLight ? "#14161A" : "#FFFFFF",
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
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
                    <polygon points="12 2.5 14.9 9 22 9.8 16.8 14.6 18.2 21.5 12 18 5.8 21.5 7.2 14.6 2 9.8 9.1 9" />
                  </svg>
                </button>
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
                      <div style={{ height: 1, background: isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)" }} />
                      <button
                        onClick={() => {
                          closeWizardMenu();
                          openPinModal();
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
                        고정
                      </button>
                    </div>
                  </>,
                  document.body
                )}

                {/* 업로드 - 예전엔 상단 헤더 우측의 + 버튼이었는데, 그 자리를 설정(⚙) 버튼에
                    내주면서 마법사 버튼 옆으로 옮겨왔다. 기존 + 버튼과 동일한 동작(홈에서는
                    Vault 생성 모달, Vault/폴더 안에서는 업로드 메뉴)을 그대로 쓰되, 다른
                    버튼들과 대비되도록 다크모드에서는 흰 배경, 라이트모드에서는 검은 배경을 쓴다. */}
                <button
                  ref={uploadButtonRef}
                  onClick={handleAddButton}
                  onMouseDown={pressDown("scale(0.9)")}
                  onMouseUp={pressUp("scale(1)")}
                  aria-label={currentPath.length === 0 ? "새 프로젝트" : "업로드"}
                  title={currentPath.length === 0 ? "새 프로젝트" : "업로드"}
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
                  {currentPath.length === 0 ? "새 프로젝트" : "업로드"}
                </button>

                {/* 숨겨진 파일 입력 - 이미지·움짤만 받는다 */}
                <input
                  ref={galleryInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/apng,image/webp,.jpg,.jpeg,.png,.gif,.apng,.webp"
                  multiple
                  onChange={handleFilesPicked}
                  style={{ display: "none" }}
                />

                {/* 업로드 메뉴 - Vault/폴더 안에서 업로드 버튼을 누르면 뜬다(홈에서는 버튼이
                    바로 Vault 생성 모달을 연다). 텍스트 문서 생성 옵션은 더 이상 없다. */}
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
                        업로드
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
                    </div>
                  </>,
                  document.body
                )}
              </div>
            </div>
            )}

            {/* 구분선 아래 드라이브 공간 - 홈에서는 Vault 카드, Vault/폴더 안에서는
                폴더(행) + 문서(행) + 이미지(비율 콜라주)를 함께 보여준다. */}
            {(() => {
              // 삼점 메뉴(이름 수정/이동/삭제) - Vault/폴더/파일 공용. Vault 에는 '이동'이 없다.
              // 버튼/래퍼 양쪽에서 stopPropagation 하고 5px 안전 여백을 둬서 근처를 눌러도
              // 항목이 열리지 않고 메뉴만 토글되도록 하며, backdropFilter 컨테이닝 블록 문제를
              // 피하기 위해 드롭다운은 document.body 로 포탈해 화면 좌표로 띄운다.
              const renderItemMenu = (type, item) => {
                const isOpen = itemMenuOpen && itemMenuOpen.type === type && itemMenuOpen.id === item.id;
                const isVisible = itemMenuVisibleKey === `${type}-${item.id}`;
                const onDelete = type === "vault" ? deleteVault : type === "folder" ? deleteFolder : deleteFile;
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
                            minWidth: 128,
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
                          {type !== "vault" && (
                            <>
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
                                  openCopyModal(type, item.id, item.name);
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
                                복사
                              </button>
                            </>
                          )}
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
                  <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                    {item.pinned && (
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        style={{ flexShrink: 0, color: isLight ? "rgba(20,22,26,0.5)" : "rgba(255,255,255,0.55)" }}
                      >
                        <path d="M16 3l5 5-3.5 3.5L19 14l-5 5-2.5-4.5L7 19l-1-1 4.5-4.5L6 11l5-5 1.5 2.5L16 3z" />
                      </svg>
                    )}
                    <div
                      style={{
                        ...textStyle,
                        flex: 1,
                        minWidth: 0,
                        userSelect: "none",
                        WebkitUserSelect: "none",
                        WebkitTouchCallout: "none",
                      }}
                    >
                      {item.name}
                    </div>
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

              // 폴더/문서 공용 행 렌더러 - 검색 결과 목록과 폴더 안 목록에서 함께 쓴다.
              const renderRow = (type, item, iconNode, subText, onNavigate) => {
                const rowDragType = type === "folder" ? "folder" : "file";
                const isPickedUp = draggingItem && draggingItem.type === rowDragType && draggingItem.id === item.id;
                return (
                <div
                  key={`${type}-${item.id}`}
                  data-drag-type={rowDragType}
                  data-drag-id={item.id}
                  onClick={() => {
                    if (justDraggedRef.current) return;
                    if (onNavigate) {
                      onNavigate();
                      return;
                    }
                    if (type === "folder") setCurrentPath([...currentPath, item.name]);
                  }}
                  onPointerDown={rowPointerDown(rowDragType, item.id)}
                  onPointerMove={rowPointerMove}
                  onPointerUp={rowPointerUp}
                  onMouseDown={pressDown("scale(0.98)")}
                  onMouseUp={pressUp("none")}
                  onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.08)"}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)";
                    e.currentTarget.style.transform = isPickedUp ? e.currentTarget.style.transform : "none";
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
                    border: `1px solid ${
                      dragOverKey === `${rowDragType}-${item.id}` || isPickedUp
                        ? (isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)")
                        : (isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)")
                    }`,
                    cursor: type === "folder" || onNavigate ? "pointer" : "default",
                    touchAction: "manipulation",
                    userSelect: "none",
                    WebkitUserSelect: "none",
                    WebkitTouchCallout: "none",
                    transform: isPickedUp ? "scale(1.03)" : "none",
                    boxShadow: isPickedUp ? "0 12px 28px rgba(0,0,0,0.3)" : "none",
                    zIndex: isPickedUp ? 5 : "auto",
                    transition: "background 0.2s ease, transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease",
                  }}
                >
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
              const renderImageGrid = (imagesArray, marginTop) => {
                if (imagesArray.length === 0) return null;
                return (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", alignItems: "start", gap: 8, marginTop }}>
                    {imagesArray.map((img) => {
                      const isPickedUp = draggingItem && draggingItem.type === "file" && draggingItem.id === img.id;
                      return (
                      <div
                        key={img.id}
                        data-drag-type="file"
                        data-drag-id={img.id}
                        onClick={() => {
                          if (justDraggedRef.current) return;
                          if (img.url) openViewer(imagesArray, imagesArray.findIndex((x) => x.id === img.id));
                        }}
                        onPointerDown={rowPointerDown("file", img.id)}
                        onPointerMove={rowPointerMove}
                        onPointerUp={rowPointerUp}
                        onMouseDown={pressDown("scale(0.97)")}
                        onMouseUp={pressUp("none")}
                        style={{
                          position: "relative",
                          borderRadius: 10,
                          overflow: "hidden",
                          border: `1px solid ${
                            dragOverKey === `file-${img.id}` || isPickedUp
                              ? (isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)")
                              : (isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)")
                          }`,
                          background: isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)",
                          cursor: img.url ? "pointer" : "default",
                          touchAction: "manipulation",
                          userSelect: "none",
                          WebkitUserSelect: "none",
                          WebkitTouchCallout: "none",
                          transform: isPickedUp ? "scale(1.04)" : "none",
                          boxShadow: isPickedUp ? "0 12px 28px rgba(0,0,0,0.3)" : "none",
                          zIndex: isPickedUp ? 5 : "auto",
                          transition: "border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease",
                        }}
                      >
                        {img.url ? (
                          <img
                            src={img.url}
                            alt={img.name}
                            draggable={false}
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
                    })}
                  </div>
                );
              };

              // ── "고정" 화면 - 별표 버튼을 누르면(pinScreenOpen) 지금 어느 위치에 있었든 상관없이
              //     앱 전체에서 고정된 폴더가 먼저 리스트로, 그 아래 고정된 문서가 리스트로, 마지막에
              //     고정된 이미지/움짤이 갤러리로 온다. "분류" 화면과 동일한 구조를 그대로 재사용한다. ──
              if (pinScreenOpen) {
                if (pinnedFolders.length === 0 && pinnedDocs.length === 0 && pinnedImages.length === 0) {
                  return (
                    <div
                      style={{
                        padding: "48px 0",
                        textAlign: "center",
                        color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.45)",
                        fontSize: 14,
                      }}
                    >
                      고정된 항목이 없습니다
                    </div>
                  );
                }
                return (
                  <>
                    {koSort(pinnedFolders).map((folder) =>
                      renderRow(
                        "folder",
                        folder,
                        <svg width="22" height="22" viewBox="0 0 24 24" fill={isLight ? "#14161A" : "#FFFFFF"}>
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>,
                        folder.path.slice(0, -1).join(" / ") || "홈",
                        () => {
                          setCurrentPath(folder.path);
                          closePinScreen();
                        }
                      )
                    )}
                    {koSort(pinnedDocs).map((doc) =>
                      renderRow(
                        "file",
                        doc,
                        getFileIcon(doc.mimeType),
                        doc.path.join(" / ") || "홈",
                        () => {
                          setCurrentPath(doc.path);
                          closePinScreen();
                        }
                      )
                    )}
                    {renderImageGrid(koSort(pinnedImages), pinnedFolders.length || pinnedDocs.length ? 8 : 0)}
                  </>
                );
              }

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
                        () => {
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
                const folderMatches = koSort(folders.filter((f) => f.name.toLowerCase().includes(trimmedQuery)));
                const allFileMatches = files.filter((f) => f.name.toLowerCase().includes(trimmedQuery));
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
                        () => {
                          setCurrentPath(item.path);
                          setSearchQuery("");
                        }
                      )
                    )}
                    {renderImageGrid(imageMatches, folderMatches.length || docMatches.length ? 8 : 0)}
                  </div>
                );
              }

              // ── 홈: Vault(프로젝트) 카드 목록 (2열, 세로 여백 넉넉히) ──
              if (currentPath.length === 0) {
                const visibleVaults = sortItems(vaults);
                if (visibleVaults.length === 0) {
                  return (
                    <div
                      style={{
                        padding: "56px 0",
                        textAlign: "center",
                        color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.45)",
                        fontSize: 14,
                        lineHeight: 1.7,
                      }}
                    >
                      아직 프로젝트가 없습니다
                    </div>
                  );
                }
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {visibleVaults.map((vault) => {
                      const isPickedUp = draggingItem && draggingItem.type === "vault" && draggingItem.id === vault.id;
                      return (
                      <div
                        key={vault.id}
                        data-drag-type="vault"
                        data-drag-id={vault.id}
                        onClick={() => {
                          if (justDraggedRef.current) return;
                          setCurrentPath([vault.name]);
                        }}
                        onPointerDown={rowPointerDown("vault", vault.id)}
                        onPointerMove={rowPointerMove}
                        onPointerUp={rowPointerUp}
                        onMouseDown={pressDown("scale(0.98)")}
                        onMouseUp={pressUp("none")}
                        onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.08)"}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)";
                          e.currentTarget.style.transform = isPickedUp ? e.currentTarget.style.transform : "none";
                        }}
                        style={{
                          position: "relative",
                          display: "flex",
                          alignItems: "center",
                          gap: 20,
                          padding: "48px 18px",
                          borderRadius: 16,
                          background: isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)",
                          backdropFilter: "blur(20px) saturate(180%)",
                          WebkitBackdropFilter: "blur(20px) saturate(180%)",
                          border: `1px solid ${
                            dragOverKey === `vault-${vault.id}` || isPickedUp
                              ? (isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)")
                              : (isLight ? "rgba(20,22,26,0.18)" : "rgba(255,255,255,0.18)")
                          }`,
                          cursor: "pointer",
                          touchAction: "manipulation",
                          userSelect: "none",
                          WebkitUserSelect: "none",
                          WebkitTouchCallout: "none",
                          transform: isPickedUp ? "scale(1.04)" : "none",
                          boxShadow: isPickedUp ? "0 16px 36px rgba(0,0,0,0.35)" : "none",
                          zIndex: isPickedUp ? 5 : "auto",
                          transition: "background 0.2s ease, transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease",
                        }}
                      >
                        {/* 좌측 중앙정렬 금고(safe) 아이콘 */}
                        <svg
                          width="52"
                          height="52"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke={isLight ? "#14161A" : "#FFFFFF"}
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          style={{ flexShrink: 0 }}
                        >
                          <rect x="3" y="3" width="20" height="20" rx="2.5" />
                          <circle cx="12" cy="12" r="4.5" />
                          <circle cx="12" cy="12" r="1" fill={isLight ? "#14161A" : "#FFFFFF"} stroke="none" />
                          <path d="M12 7.5v1M12 15.5v1M7.5 12h1M15.5 12h1" />
                        </svg>

                        {/* 중앙: 제목(볼드) + 밑에 통계 */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {renderEditableName("vault", vault, {
                            color: isLight ? "#14161A" : "#FFFFFF",
                            fontSize: 17,
                            fontWeight: 700,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          })}
                          <div
                            style={{
                              marginTop: 5,
                              color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)",
                              fontSize: 13,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {vaultStatsText(vault.name)}
                          </div>
                        </div>

                        {/* 우측 중앙정렬 삼점 메뉴 */}
                        {renderItemMenu("vault", vault)}
                      </div>
                      );
                    })}
                  </div>
                );
              }

              // ── Vault/폴더 안: 폴더(행) + 문서(행) + 이미지(콜라주) ──
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

              // 폴더/문서 공용 행 렌더러
              return (
                <>
                  {/* 폴더 행 */}
                  {visibleFolders.map((folder) =>
                    renderRow(
                      "folder",
                      folder,
                      <svg width="22" height="22" viewBox="0 0 24 24" fill={isLight ? "#14161A" : "#FFFFFF"}>
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>,
                      null
                    )
                  )}

                  {/* 문서(TXT) 행 */}
                  {visibleDocs.map((doc) =>
                    renderRow("file", doc, getFileIcon(doc.mimeType), formatFileSize(doc.size))
                  )}

                  {/* 이미지/움짤 콜라주 - 비율 유지한 2열 메이슨리 */}
                  {renderImageGrid(visibleImages, visibleFolders.length || visibleDocs.length ? 8 : 0)}
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
                최적화는 이미지/움짤에 한정해 원본 해상도의 50%로 줄여서 올린다. 업로드 도중
                스위치를 바꿔도 이미 시작된 업로드에는 적용되지 않고, 그 다음 업로드부터
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
              <div style={{ fontSize: 15, fontWeight: 500, color: isLight ? "#14161A" : "#FFFFFF", marginBottom: 8 }}>
                업로드
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
                뜬다. 사용량이 기본 10GB 이하면 금액 텍스트를 보여주지 않는다. */}
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
                  ref={pricingButtonRef}
                  onClick={showPricingInfo}
                  disabled={pricingInfoOpen}
                  aria-label="요금 안내"
                  style={{
                    width: 18,
                    height: 18,
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    color: isLight ? "rgba(20,22,26,0.28)" : "rgba(255,255,255,0.28)",
                    cursor: pricingInfoOpen ? "default" : "pointer",
                    outline: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: pricingInfoOpen ? 0.5 : 1,
                    transition: "opacity 0.3s ease, color 0.2s ease",
                  }}
                  onMouseEnter={(e) => { if (!pricingInfoOpen) e.currentTarget.style.color = isLight ? "rgba(20,22,26,0.5)" : "rgba(255,255,255,0.5)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = isLight ? "rgba(20,22,26,0.28)" : "rgba(255,255,255,0.28)"; }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 2-3 4" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </button>
              </div>
              {billingOverageGB > 0 && (
                <div style={{ fontSize: 12, fontWeight: 400, color: isLight ? "#14161A" : "#FFFFFF" }}>
                  {billingOverageGB % 1 === 0 ? billingOverageGB : billingOverageGB.toFixed(1)}GB ({billingAmount.toFixed(2)}$/월)
                </div>
              )}
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

            {/* 휴지통 화면 - 삭제된 Vault/폴더/파일이 삭제된 시점으로부터 7일간 여기 담긴다.
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
                                minWidth: 128,
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

      {/* Vault(프로젝트) 생성 모달 - 제목 "Vault" + 우측 X, 인풋 + 오른쪽 생성 버튼.
          빈 배경(딤 오버레이) 클릭 시 취소된다. */}
      {vaultModalOpen && (
        <>
          <div
            onClick={closeVaultModal}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0,0,0,0.4)",
              zIndex: 39,
              opacity: vaultModalVisible ? 1 : 0,
              transition: "opacity 0.2s ease",
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: vaultModalVisible ? "translate(-50%, -50%) scale(1)" : "translate(-50%, -50%) scale(0.92)",
              opacity: vaultModalVisible ? 1 : 0,
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
            {/* 제목 + 우측 끝 X 버튼 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <h2
                style={{
                  margin: 0,
                  fontSize: 19,
                  fontWeight: 700,
                  color: isLight ? "#14161A" : "#FFFFFF",
                }}
              >
                Vault
              </h2>
              <button
                onClick={closeVaultModal}
                onMouseDown={pressDown("scale(0.85)")}
                onMouseUp={pressUp("scale(1)")}
                aria-label="닫기"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
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

            {/* 설명 글씨 */}
            <div
              style={{
                marginBottom: 8,
                color: isLight ? "rgba(20,22,26,0.5)" : "rgba(255,255,255,0.58)",
                fontSize: 14,
              }}
            >
              새 프로젝트 만들기
            </div>

            {/* 인풋 + 오른쪽 생성 버튼 */}
            <div style={{ display: "flex", gap: 10 }}>
              <input
                type="text"
                value={vaultNameInput}
                onChange={(e) => setVaultNameInput(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") createVault();
                  if (e.key === "Escape") closeVaultModal();
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: 12,
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
                  borderRadius: 8,
                  background: isLight ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.06)",
                  color: isLight ? "#14161A" : "#FFFFFF",
                  fontSize: 17,
                  outline: "none",
                  boxSizing: "border-box",
                  transition: "border-color 0.2s ease",
                }}
              />
              <button
                onClick={createVault}
                onMouseDown={pressDown("scale(0.95)")}
                onMouseUp={pressUp("scale(1)")}
                style={{
                  flexShrink: 0,
                  padding: "0 16px",
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
                생성
              </button>
            </div>
          </div>
        </>
      )}

      {/* 정보 모달 - 이름/생성 일자/수정 일자/크기를 보여주는 단순 정보 모달.
          Vault/폴더/파일 공용. 별도 확인 버튼 없이 상단 제목열 오른쪽 X로만 닫는다. */}
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
                // 확장자 - Vault/폴더는 확장자 개념이 없으므로 파일(이미지/움짤/텍스트 등)일 때만 보여준다.
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
                  {moveBrowsePath.length === 0 ? "Vault가 없습니다" : "하위 폴더가 없습니다"}
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

      {/* 복사 모달 - 이동 모달과 완전히 동일한 디자인/탐색 흐름. */}
      {copyModalOpen && (
        <>
          <div
            onClick={closeCopyModal}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0,0,0,0.4)",
              zIndex: 39,
              opacity: copyModalVisible ? 1 : 0,
              transition: "opacity 0.2s ease",
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: copyModalVisible ? "translate(-50%, -50%) scale(1)" : "translate(-50%, -50%) scale(0.92)",
              opacity: copyModalVisible ? 1 : 0,
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
                {copyTarget ? copyTarget.name : "복사"}
              </h2>
              <button
                onClick={closeCopyModal}
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
                onClick={() => setCopyBrowsePath([])}
                style={{
                  background: "none",
                  border: "none",
                  color: isLight ? "#14161A" : "#FFFFFF",
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: "pointer",
                  padding: 0,
                  outline: "none",
                  opacity: copyBrowsePath.length === 0 ? 1 : 0.7,
                }}
              >
                홈
              </button>
              {copyBrowsePath.map((seg, index) => (
                <div key={index} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)", fontSize: 14 }}>&gt;</span>
                  <button
                    onClick={() => setCopyBrowsePath(copyBrowsePath.slice(0, index + 1))}
                    style={{
                      background: "none",
                      border: "none",
                      color: isLight ? "#14161A" : "#FFFFFF",
                      fontSize: 14,
                      fontWeight: 500,
                      cursor: "pointer",
                      padding: 0,
                      outline: "none",
                      opacity: index === copyBrowsePath.length - 1 ? 1 : 0.7,
                    }}
                  >
                    {seg}
                  </button>
                </div>
              ))}
            </div>

            <div style={{ maxHeight: 300, overflowY: "auto", marginBottom: 16 }}>
              {copyModalEntries.length === 0 ? (
                <div
                  style={{
                    padding: "24px 0",
                    textAlign: "center",
                    color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.45)",
                    fontSize: 14,
                  }}
                >
                  {copyBrowsePath.length === 0 ? "Vault가 없습니다" : "하위 폴더가 없습니다"}
                </div>
              ) : (
                copyModalEntries.map((entry) => (
                  <div
                    key={entry.id}
                    onClick={() => setCopyBrowsePath([...copyBrowsePath, entry.name])}
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
              onClick={confirmCopy}
              disabled={!canCopyHere}
              onMouseDown={canCopyHere ? pressDown("scale(0.95)") : undefined}
              onMouseUp={canCopyHere ? pressUp("scale(1)") : undefined}
              style={{
                width: "100%",
                padding: 10,
                border: "none",
                borderRadius: 8,
                background: isLight ? "#14161A" : "#FFFFFF",
                color: isLight ? "#FFFFFF" : "#14161A",
                fontSize: 15,
                fontWeight: 600,
                cursor: canCopyHere ? "pointer" : "not-allowed",
                opacity: canCopyHere ? 1 : 0.4,
                outline: "none",
                transition: "transform 0.15s ease, opacity 0.2s ease",
              }}
              onMouseEnter={(e) => { if (canCopyHere) e.currentTarget.style.transform = "translateY(-1px)"; }}
              onMouseLeave={(e) => e.currentTarget.style.transform = "translateY(0)"}
            >
              복사
            </button>
          </div>
        </>
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

      {/* 업로드 현황 패널 - 화면 우측 하단에 떠서 파일별 진행/완료/대기 상태와 전송량을
          보여준다. 업로드가 새로 시작되면 다시 나타나고, X를 누르면 닫힌다(업로드 자체는
          백그라운드에서 계속된다). */}
      {uploadQueue.length > 0 && !uploadPanelClosed && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            width: 280,
            maxWidth: "calc(100vw - 48px)",
            borderRadius: 16,
            background: isLight ? "rgba(255,255,255,0.85)" : "rgba(30,29,28,0.9)",
            backdropFilter: "blur(20px) saturate(180%)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            border: `1px solid ${isLight ? "rgba(20,22,26,0.20)" : "rgba(255,255,255,0.20)"}`,
            boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
            zIndex: 45,
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
            <span style={{ fontSize: 14, fontWeight: 700, color: isLight ? "#14161A" : "#FFFFFF" }}>업로드</span>
            <button
              onClick={() => setUploadPanelClosed(true)}
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
            {uploadQueue.map((item) => (
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
                  {item.status === "uploading" && "진행"}
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
      )}

      {/* 요금 안내 패널 - 서브 액션바와 같은 리퀴드 글래스 배경을 쓰되, 하단 고정이 아니라
          눌린 물음표 아이콘 바로 밑 위치(pricingInfoPos)에 뜬다. 레이아웃 흐름에 얹지 않고
          document.body에 포탈로 띄워 다른 내용을 밀어내지 않는다. */}
      {pricingInfoOpen && createPortal(
        <div
          style={{
            position: "fixed",
            top: pricingInfoPos.top,
            left: pricingInfoPos.left,
            transform: pricingInfoVisible ? "translateY(0)" : "translateY(8px)",
            opacity: pricingInfoVisible ? 1 : 0,
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
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: isLight ? "#14161A" : "#FFFFFF" }}>
            Vaulty 는 종량제를 따라 요금을 부과하고 있습니다
          </div>
          <div style={{ fontSize: 12, fontWeight: 400, color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.55)", marginTop: 4 }}>
            기본 저장 공간 10GB를 초과하면 $0.015/GB 가 청구됩니다
          </div>
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

      {/* 고정 모달 - 변환/태그 모달과 동일한 레이아웃(제목 + 전체 선택 + 리스트 + 적용)이되
          이름/태그 편집 없이 체크박스만으로 고정 여부를 정한다. Vault는 대상에서 제외된다. */}
      {pinModalOpen && (
        <>
          <div
            onClick={closePinModal}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0,0,0,0.45)",
              zIndex: 39,
              opacity: pinModalVisible ? 1 : 0,
              transition: "opacity 0.2s ease",
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: pinModalVisible ? "translate(-50%, -50%) scale(1)" : "translate(-50%, -50%) scale(0.92)",
              opacity: pinModalVisible ? 1 : 0,
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
                고정
              </h2>
              <button
                onClick={closePinModal}
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
              onClick={togglePinSelectAll}
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
              {pinTargets.length === 0 && (
                <div
                  style={{
                    textAlign: "center",
                    padding: "20px 0",
                    color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.45)",
                    fontSize: 14,
                  }}
                >
                  고정할 항목이 없습니다
                </div>
              )}
              {pinTargets.map((item) => (
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
                    checked={!!pinChecked[item.id]}
                    onChange={() => togglePinChecked(item.id)}
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
                      color: isLight ? "#14161A" : "#FFFFFF",
                    }}
                  >
                    {item.name}
                  </span>
                </label>
              ))}
            </div>

            <button
              onClick={handlePinApply}
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
