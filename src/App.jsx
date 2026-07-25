import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";

// 앱 버전 표기
const APP_VERSION = "0.2.2";

export default function Alloy() {
  const tabs = ["A", "B", "C"];
  // 상단 바 제목 - 홈 탭만 "Vaulty" 브랜드를 보여주고, 아직 기능이 없는 나머지 두 탭은 비워둔다.
  const TAB_TITLES = ["Vaulty", "", ""];
  const [active, setActive] = useState(0);

  // 탭 전환 시 이전 탭의 스크롤 위치가 유지되어 콘텐츠가 적은 탭에서
  // 스크롤이 아래로 내려간 채로 보이는 문제 방지
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [active]);

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
    light: "#FFFFFF",
    dark: "#141413",
    sunset: "radial-gradient(circle at 50% 50%, #47301e 0%, #2a1f1a 55%, #17191D 95%)",
    forest: "radial-gradient(circle at 50% 50%, #1f3d28 0%, #1a2a20 55%, #17191D 95%)",
  };
  const [themeLoaded, setThemeLoaded] = useState(false);
  const isLight = theme === "light";
  // 설정 탭의 라이트/다크 스위치 - sunset/forest 테마는 그대로 두고 light<->dark만 오간다.
  const toggleLightDark = () => setTheme(isLight ? "dark" : "light");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("alloy_theme");
      if (saved === "light" || saved === "sunset" || saved === "forest") setTheme(saved);
    } catch (e) {}
    setThemeLoaded(true);
  }, []);

  useEffect(() => {
    if (!themeLoaded) return;
    try {
      localStorage.setItem("alloy_theme", theme);
    } catch (e) {}
  }, [theme, themeLoaded]);

  const [hovered, setHovered] = useState(null);
  const btnRefs = useRef([]);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  useEffect(() => {
    const el = btnRefs.current[active];
    if (el) {
      setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
    }
  }, [active, isLight]);

  const BAR_HEIGHT = 58;

  // 하단 바의 원형 검색 버튼 - 누르면 탭바 위에 같은 디자인의 검색창 패널이 열린다.
  // Cloudflare R2 연동 전이라 아직 실제 검색은 수행하지 않고 입력값만 로컬 상태로 들고 있는다.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchButtonHovered, setSearchButtonHovered] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const searchInputRef = useRef(null);

  // Vaulty 데이터 모델: Vault(프로젝트) > Folder(폴더) > Data(이미지/문서)
  //  - vaults: 홈 화면에 카드로 보이는 최상위 프로젝트 [{id, name}]
  //  - folders: path[0]가 소속 Vault 이름이며 path 는 자기 이름까지 포함
  //  - files: path 는 소속 디렉터리(= Vault 이름 포함). kind 는 'image' | 'doc'
  //    · 이미지/움짤(JPG/JPEG/PNG/GIF/APNG)과 텍스트(TXT)만 업로드 가능
  //    · 문서(doc)는 Vault 바로 아래(path.length === 1)에서만 생성/보관 가능
  const [currentPath, setCurrentPath] = useState([]); // [] = 홈(Vault 목록)
  const [vaults, setVaults] = useState([]);
  const [folders, setFolders] = useState([]);
  const [files, setFiles] = useState([]);

  // Vault 생성 모달
  const [vaultModalOpen, setVaultModalOpen] = useState(false);
  const [vaultModalVisible, setVaultModalVisible] = useState(false);
  const [vaultNameInput, setVaultNameInput] = useState("");
  const docInputRef = useRef(null);

  const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "apng"];
  const getKindFromName = (name) => {
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (IMAGE_EXTS.includes(ext)) return "image";
    if (ext === "txt") return "doc";
    return null;
  };

  const [uploadButtonHovered, setUploadButtonHovered] = useState(false);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [uploadMenuVisible, setUploadMenuVisible] = useState(false);
  // 업로드 메뉴 드롭다운 위치 - backdropFilter가 걸린 상단 헤더 안에 있으면 position:fixed
  // 오버레이가 뷰포트가 아닌 헤더를 기준으로 잡히므로(모든 filter/backdrop-filter/transform
  // 속성은 fixed 자손의 컨테이닝 블록을 새로 만든다), 드롭다운을 document.body로 포탈하고
  // 버튼의 화면 좌표를 직접 계산해 고정 위치로 띄운다.
  const uploadButtonRef = useRef(null);
  const [uploadMenuAnchor, setUploadMenuAnchor] = useState({ top: 0, right: 0 });
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderModalVisible, setFolderModalVisible] = useState(false);
  const [folderName, setFolderName] = useState("");
  // 폴더/파일 삼점 메뉴 - 리스트/갤러리 통틀어 한 번에 하나만 열리도록 단일 상태로 관리한다.
  // 이 메뉴 역시 backdropFilter가 걸린 행(row) 안에 있으므로 위와 같은 이유로 포탈 + 고정 좌표를 쓴다.
  const [itemMenuOpen, setItemMenuOpen] = useState(null); // { type: 'folder' | 'file', id }
  const [itemMenuVisibleKey, setItemMenuVisibleKey] = useState(null);
  const [itemMenuAnchor, setItemMenuAnchor] = useState({ top: 0, right: 0 });
  // Vault 삭제 - 확인 문구 없이, 삭제 버튼을 한 번 누르면 배경이 붉게 변하고(armed) 같은
  // 버튼을 한 번 더 누르면 그때 실제로 삭제된다.
  const [vaultDeleteArmedId, setVaultDeleteArmedId] = useState(null);
  const galleryInputRef = useRef(null);
  const fileInputRef = useRef(null);

  const toggleSearch = () => {
    if (searchOpen) {
      if (document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
      }
      setSearchVisible(false);
      setTimeout(() => {
        setSearchOpen(false);
        setSearchQuery("");
      }, 300);
    } else {
      setSearchOpen(true);
      requestAnimationFrame(() => {
        setSearchVisible(true);
        searchInputRef.current && searchInputRef.current.focus();
      });
    }
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && searchOpen) {
        e.preventDefault();
        toggleSearch();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchOpen]);

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
      setVaults((prev) => [...prev, { id: now, name: vaultNameInput.trim(), createdAt: now, updatedAt: now }]);
    }
    closeVaultModal();
  };
  const deleteVault = (vaultId) => {
    const vault = vaults.find((v) => v.id === vaultId);
    if (vault) {
      setFolders((prev) => prev.filter((f) => f.path[0] !== vault.name));
      setFiles((prev) => prev.filter((f) => f.path[0] !== vault.name));
    }
    setVaults((prev) => prev.filter((v) => v.id !== vaultId));
    closeItemMenu();
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
    setVaultDeleteArmedId(null);
    setTimeout(() => setItemMenuOpen(null), 200);
  };
  const toggleItemMenu = (type, id, anchorEl) => {
    if (itemMenuOpen && itemMenuOpen.type === type && itemMenuOpen.id === id) closeItemMenu();
    else openItemMenu(type, id, anchorEl);
  };

  const createFolder = () => {
    if (folderName.trim()) {
      const newFolder = {
        id: Date.now(),
        name: folderName,
        path: [...currentPath, folderName],
      };
      setFolders([...folders, newFolder]);
    }
    closeFolderModal();
  };

  const deleteFolder = (folderId) => {
    setFolders(folders.filter(f => f.id !== folderId));
    closeItemMenu();
  };

  // 정렬 - 단일 "ABC" 버튼 하나로 가나다순 -> 숫자순 -> 알파벳순을 순환한다.
  // 사용자 지정(꾹 눌러서 드래그) 정렬을 사용하면 배열 자체의 순서를 그대로 쓴다.
  const SORT_MODES = ["ko", "num", "en"];
  const [sortModeIndex, setSortModeIndex] = useState(0);
  const [customOrderActive, setCustomOrderActive] = useState(false);
  const sortMode = customOrderActive ? "custom" : SORT_MODES[sortModeIndex];
  const cycleSortMode = () => {
    setCustomOrderActive(false);
    setSortModeIndex((i) => (i + 1) % SORT_MODES.length);
  };

  const sortItems = (items) => {
    if (sortMode === "custom") return items;
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
        return a.name.localeCompare(b.name);
      });
    } else if (sortMode === "en") {
      sorted.sort((a, b) => a.name.localeCompare(b.name, "en"));
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    }
    return sorted;
  };

  // 폴더/문서 꾹 눌러서 드래그로 섹션 내 순서 변경(사용자 지정 정렬)
  const [draggingItem, setDraggingItem] = useState(null); // { type: 'folder' | 'file', id }
  const [dragOverKey, setDragOverKey] = useState(null);
  const draggingItemRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const longPressStartRef = useRef(null);
  const justDraggedRef = useRef(false);

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
    setTimeout(() => {
      justDraggedRef.current = false;
    }, 80);
    window.removeEventListener("pointermove", handleDragPointerMove);
    window.removeEventListener("pointerup", handleDragPointerUp);
  };

  const beginDrag = (type, id) => {
    setDraggingItem({ type, id });
    window.addEventListener("pointermove", handleDragPointerMove);
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
  const commitInlineEdit = () => {
    if (!editingItem) return;
    const newName = editingValue.trim();
    if (newName) {
      if (editingItem.type === "vault") {
        const vault = vaults.find((v) => v.id === editingItem.id);
        const oldName = vault ? vault.name : null;
        setVaults((prev) => prev.map((v) => (v.id === editingItem.id ? { ...v, name: newName, updatedAt: Date.now() } : v)));
        // Vault 이름이 바뀌면 그 하위 폴더/파일들의 path[0]도 함께 갱신한다.
        if (oldName && oldName !== newName) {
          setFolders((prev) => prev.map((f) => (f.path[0] === oldName ? { ...f, path: [newName, ...f.path.slice(1)] } : f)));
          setFiles((prev) => prev.map((f) => (f.path[0] === oldName ? { ...f, path: [newName, ...f.path.slice(1)] } : f)));
        }
      } else if (editingItem.type === "folder") {
        setFolders((prev) => prev.map((f) => (f.id === editingItem.id ? { ...f, name: newName } : f)));
      } else {
        setFiles((prev) => prev.map((f) => (f.id === editingItem.id ? { ...f, name: newName } : f)));
      }
    }
    setEditingItem(null);
    setEditingValue("");
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
  const movingIsDoc = movingFile && movingFile.kind === "doc";
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

  // 실제 갤러리/파일 선택 다이얼로그(input[type=file])를 통해 고른 항목을
  // 현재 위치(currentPath)에 저장 - 아직 Cloudflare R2 연동 전이라 로컬 상태로만 보관.
  // 지원 형식(JPG/JPEG/PNG/GIF/APNG/TXT)만 받아들이고, 이미지는 미리보기용 object URL 을 만든다.
  const handleFilesPicked = (e) => {
    const selected = Array.from(e.target.files || []);
    const accepted = [];
    for (const f of selected) {
      const kind = getKindFromName(f.name);
      if (!kind) continue; // 미지원 형식은 건너뛴다
      accepted.push({
        id: Date.now() + Math.random(),
        name: f.name,
        size: f.size,
        mimeType: f.type,
        kind,
        url: kind === "image" ? URL.createObjectURL(f) : null,
        path: currentPath,
      });
    }
    if (accepted.length) setFiles((prev) => [...prev, ...accepted]);
    e.target.value = "";
  };

  const deleteFile = (fileId) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId));
    closeItemMenu();
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

  const formatDate = (ts) =>
    ts ? new Date(ts).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }) : "-";

  // Vault 정보 모달 - 삼점 메뉴의 "정보"를 누르면 대형 모달로 생성/수정 일자와 크기를 보여준다.
  const [vaultInfoModalOpen, setVaultInfoModalOpen] = useState(false);
  const [vaultInfoModalVisible, setVaultInfoModalVisible] = useState(false);
  const [vaultInfoTargetId, setVaultInfoTargetId] = useState(null);

  const openVaultInfoModal = (vaultId) => {
    setVaultInfoTargetId(vaultId);
    setVaultInfoModalOpen(true);
    requestAnimationFrame(() => setVaultInfoModalVisible(true));
  };
  const closeVaultInfoModal = () => {
    setVaultInfoModalVisible(false);
    setTimeout(() => {
      setVaultInfoModalOpen(false);
      setVaultInfoTargetId(null);
    }, 200);
  };
  const vaultInfoTarget = vaultInfoTargetId ? vaults.find((v) => v.id === vaultInfoTargetId) : null;

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
  const stickyHeaderStyle = {
    position: "sticky",
    top: 0,
    zIndex: 5,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    margin: "0 -20px 24px -20px",
    padding: "22px 20px 14px 20px",
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
          background: ${isLight ? "#FFFFFF" : "#141413"};
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

      {/* 탭 콘텐츠 영역 */}
      <div
        style={{
          minHeight: vh,
          width: "100%",
          boxSizing: "border-box",
          padding: "0 20px 140px 20px",
        }}
      >
        {/* 상단 헤더 */}
        <div style={stickyHeaderStyle}>
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: 26,
                fontWeight: 700,
                color: isLight ? "#14161A" : "#FFFFFF",
                letterSpacing: 0.2,
                minHeight: "1em",
              }}
            >
              {TAB_TITLES[active]}
            </h1>
          </div>

          {/* 업로드 버튼 - 하단 검색 버튼과 동일한 크기(BAR_HEIGHT)의 리퀴드 글래스 원형 + 애니메이션 */}
          {active === 0 && (
            <div style={{ position: "relative" }}>
              <button
                ref={uploadButtonRef}
                onClick={handleAddButton}
                onMouseEnter={() => setUploadButtonHovered(true)}
                onMouseLeave={(e) => {
                  setUploadButtonHovered(false);
                  e.currentTarget.style.transform = "scale(1)";
                }}
                onMouseDown={pressDown("scale(0.9)")}
                onMouseUp={pressUp(uploadButtonHovered ? "scale(1.08)" : "scale(1)")}
                onTouchStart={pressDown("scale(0.9)")}
                onTouchEnd={pressUp("scale(1)")}
                style={{
                  width: BAR_HEIGHT,
                  height: BAR_HEIGHT,
                  flexShrink: 0,
                  borderRadius: "50%",
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
                  background: uploadMenuOpen || uploadButtonHovered
                    ? (isLight ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.14)")
                    : (isLight ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.06)"),
                  backdropFilter: "blur(20px) saturate(180%)",
                  WebkitBackdropFilter: "blur(20px) saturate(180%)",
                  boxShadow: uploadButtonHovered
                    ? "0 10px 36px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.3)"
                    : "0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  color: isLight ? "#14161A" : "#FFFFFF",
                  outline: "none",
                  transition: "background 0.3s ease, box-shadow 0.3s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
                  transform: uploadButtonHovered ? "scale(1.08)" : "scale(1)",
                }}
                aria-label="추가하기"
              >
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  style={{
                    transition: "transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)",
                    transform: uploadMenuOpen ? "rotate(45deg)" : "rotate(0deg)",
                  }}
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>

              {/* 숨겨진 파일 입력 - 갤러리/파일은 이미지·움짤만, 문서는 텍스트(TXT)만 받는다 */}
              <input
                ref={galleryInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/apng,.jpg,.jpeg,.png,.gif,.apng"
                multiple
                onChange={handleFilesPicked}
                style={{ display: "none" }}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/apng,.jpg,.jpeg,.png,.gif,.apng"
                multiple
                onChange={handleFilesPicked}
                style={{ display: "none" }}
              />
              <input
                ref={docInputRef}
                type="file"
                accept="text/plain,.txt"
                multiple
                onChange={handleFilesPicked}
                style={{ display: "none" }}
              />

              {/* 업로드 메뉴 - 부드러운 페이드 + 슬라이드 애니메이션. 상단 헤더에 backdropFilter가
                  걸려 있어 position:fixed 자손의 컨테이닝 블록이 헤더로 제한되므로, 헤더 바깥
                  document.body로 포탈하고 버튼의 화면 좌표를 계산한 고정 위치로 띄운다. */}
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
                      border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
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
                      갤러리
                    </button>
                    <button
                      onClick={() => {
                        closeUploadMenu();
                        fileInputRef.current && fileInputRef.current.click();
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
                    <div style={{ height: 1, background: isLight ? "rgba(20,22,26,0.12)" : "rgba(255,255,255,0.12)" }} />
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
                    {/* 문서는 Vault 바로 아래(currentPath.length === 1)에서만 생성 가능 */}
                    {currentPath.length === 1 && (
                      <button
                        onClick={() => {
                          closeUploadMenu();
                          docInputRef.current && docInputRef.current.click();
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
                    )}
                  </div>
                </>,
                document.body
              )}
            </div>
          )}
        </div>

        {/* 홈 탭 콘텐츠 */}
        {active === 0 && (
          <>
            {/* 경로 표기 및 정렬/보기 방식 아이콘 영역 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingBottom: 12,
                marginBottom: 16,
                borderBottom: `1px solid ${isLight ? "rgba(20,22,26,0.12)" : "rgba(255,255,255,0.12)"}`,
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
                    <span style={{ color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)", fontSize: 15 }}>
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

              {/* 정렬 / 보기 방식 아이콘 */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  onClick={cycleSortMode}
                  onMouseDown={pressDown("scale(0.9)")}
                  onMouseUp={pressUp("scale(1)")}
                  aria-label="정렬"
                  title="정렬"
                  style={{
                    minWidth: 36,
                    height: 30,
                    padding: "0 8px",
                    borderRadius: 8,
                    border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
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
                  ABC
                </button>
              </div>
            </div>

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
                            border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
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
                            {type === "vault" ? "이름 바꾸기" : "이름 수정"}
                          </button>
                          {type === "vault" && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                closeItemMenu();
                                openVaultInfoModal(item.id);
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
                          )}
                          {type !== "vault" && (
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
                          )}
                          <div style={{ height: 1, background: isLight ? "rgba(20,22,26,0.12)" : "rgba(255,255,255,0.12)" }} />
                          {type === "vault" ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (vaultDeleteArmedId === item.id) {
                                  onDelete(item.id);
                                } else {
                                  setVaultDeleteArmedId(item.id);
                                }
                              }}
                              style={{
                                width: "100%",
                                padding: "10px 12px",
                                border: "none",
                                background: vaultDeleteArmedId === item.id ? "#EF4444" : "transparent",
                                color: vaultDeleteArmedId === item.id ? "#FFFFFF" : "#EF4444",
                                fontSize: 15,
                                fontWeight: 500,
                                cursor: "pointer",
                                outline: "none",
                                textAlign: "left",
                                transition: "background 0.15s ease, color 0.15s ease",
                              }}
                              onMouseEnter={(e) => {
                                if (vaultDeleteArmedId !== item.id) e.currentTarget.style.background = isLight ? "rgba(239,68,68,0.06)" : "rgba(239,68,68,0.1)";
                              }}
                              onMouseLeave={(e) => {
                                if (vaultDeleteArmedId !== item.id) e.currentTarget.style.background = "transparent";
                              }}
                            >
                              삭제
                            </button>
                          ) : (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onDelete(item.id);
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
                                transition: "background 0.2s",
                              }}
                              onMouseEnter={(e) => e.currentTarget.style.background = isLight ? "rgba(239,68,68,0.06)" : "rgba(239,68,68,0.1)"}
                              onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                            >
                              삭제
                            </button>
                          )}
                        </div>
                      </>,
                      document.body
                    )}
                  </div>
                );
              };

              // 항목 제목 텍스트 - 클릭하면(또는 "이름 바꾸기" 메뉴를 누르면) 그 자리에서
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
                    onClick={(e) => {
                      e.stopPropagation();
                      startInlineEdit(type, item.id, item.name);
                    }}
                    style={{ ...textStyle, cursor: "text" }}
                  >
                    {item.name}
                  </div>
                );
              };

              // ── 홈: Vault(프로젝트) 카드 목록 (2열, 세로 여백 넉넉히) ──
              if (currentPath.length === 0) {
                const visibleVaults = sortItems(vaults);
                if (visibleVaults.length === 0) {
                  return (
                    <div
                      style={{
                        padding: "56px 0",
                        textAlign: "center",
                        color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.35)",
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
                    {visibleVaults.map((vault) => (
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
                          e.currentTarget.style.transform = "none";
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
                            dragOverKey === `vault-${vault.id}` || (draggingItem && draggingItem.type === "vault" && draggingItem.id === vault.id)
                              ? (isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)")
                              : (isLight ? "rgba(20,22,26,0.12)" : "rgba(255,255,255,0.12)")
                          }`,
                          cursor: "pointer",
                          touchAction: "manipulation",
                          transition: "background 0.2s ease, transform 0.15s ease, border-color 0.15s ease",
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
                              color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)",
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
                    ))}
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
              const visibleDocs = sortItems(filesHere.filter((f) => f.kind === "doc"));
              const visibleImages = sortItems(filesHere.filter((f) => f.kind === "image"));

              if (visibleFolders.length === 0 && visibleDocs.length === 0 && visibleImages.length === 0) {
                return (
                  <div
                    style={{
                      padding: "48px 0",
                      textAlign: "center",
                      color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.35)",
                      fontSize: 14,
                    }}
                  >
                    비어 있습니다
                  </div>
                );
              }

              // 폴더/문서 공용 행 렌더러
              const renderRow = (type, item, iconNode, subText) => (
                <div
                  key={`${type}-${item.id}`}
                  data-drag-type={type === "folder" ? "folder" : "file"}
                  data-drag-id={item.id}
                  onClick={() => {
                    if (justDraggedRef.current) return;
                    if (type === "folder") setCurrentPath([...currentPath, item.name]);
                  }}
                  onPointerDown={rowPointerDown(type === "folder" ? "folder" : "file", item.id)}
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
                    padding: "12px 18px",
                    marginBottom: 8,
                    borderRadius: 10,
                    background: isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)",
                    backdropFilter: "blur(20px) saturate(180%)",
                    WebkitBackdropFilter: "blur(20px) saturate(180%)",
                    border: `1px solid ${
                      dragOverKey === `${type === "folder" ? "folder" : "file"}-${item.id}` ||
                      (draggingItem && draggingItem.id === item.id)
                        ? (isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)")
                        : (isLight ? "rgba(20,22,26,0.12)" : "rgba(255,255,255,0.12)")
                    }`,
                    cursor: type === "folder" ? "pointer" : "default",
                    touchAction: "manipulation",
                    transition: "background 0.2s ease, transform 0.15s ease, border-color 0.15s ease",
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
                    {subText && (
                      <div style={{ color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)", fontSize: 13, marginTop: 2 }}>
                        {subText}
                      </div>
                    )}
                  </div>
                  {renderItemMenu(type === "folder" ? "folder" : "file", item)}
                </div>
              );

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
                  {visibleImages.length > 0 && (
                    <div style={{ columnCount: 2, columnGap: 8, marginTop: visibleFolders.length || visibleDocs.length ? 8 : 0 }}>
                      {visibleImages.map((img) => (
                        <div
                          key={img.id}
                          data-drag-type="file"
                          data-drag-id={img.id}
                          onPointerDown={rowPointerDown("file", img.id)}
                          onPointerMove={rowPointerMove}
                          onPointerUp={rowPointerUp}
                          style={{
                            position: "relative",
                            breakInside: "avoid",
                            WebkitColumnBreakInside: "avoid",
                            marginBottom: 8,
                            borderRadius: 10,
                            overflow: "hidden",
                            border: `1px solid ${
                              dragOverKey === `file-${img.id}` || (draggingItem && draggingItem.type === "file" && draggingItem.id === img.id)
                                ? (isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)")
                                : (isLight ? "rgba(20,22,26,0.12)" : "rgba(255,255,255,0.12)")
                            }`,
                            background: isLight ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.04)",
                            touchAction: "manipulation",
                            transition: "border-color 0.15s ease",
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
                          {/* 이미지 위 삼점 메뉴 (어두운 스크림 알약 위에) */}
                          <div
                            style={{
                              position: "absolute",
                              top: 4,
                              right: 4,
                              borderRadius: 8,
                              background: "rgba(0,0,0,0.35)",
                              backdropFilter: "blur(6px)",
                              WebkitBackdropFilter: "blur(6px)",
                              color: "#FFFFFF",
                            }}
                          >
                            {renderItemMenu("file", img)}
                          </div>
                          {/* 이미지 제목 - 눌러서 인라인 수정 가능 */}
                          <div style={{ padding: "6px 8px" }} onClick={(e) => e.stopPropagation()}>
                            {renderEditableName("file", img, {
                              color: isLight ? "#14161A" : "#FFFFFF",
                              fontSize: 12,
                              fontWeight: 500,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
          </>
        )}

        {/* 설정 탭 콘텐츠 - 라이트/다크 테마 전환 스위치 (텍스트 없이 해/달 아이콘으로만 구분) */}
        {active === 2 && (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              onClick={toggleLightDark}
              onMouseDown={pressDown("scale(0.94)")}
              onMouseUp={pressUp("scale(1)")}
              aria-label="라이트/다크 테마 전환"
              style={{
                position: "relative",
                width: 64,
                height: 32,
                borderRadius: 999,
                border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
                background: isLight ? "rgba(20,22,26,0.08)" : "rgba(255,255,255,0.1)",
                cursor: "pointer",
                outline: "none",
                padding: 0,
                transition: "background 0.3s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
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
              border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
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
                color: isLight ? "rgba(20,22,26,0.5)" : "rgba(255,255,255,0.5)",
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
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
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

      {/* Vault 정보 모달 - 이름/생성 일자/수정 일자/크기를 보여주는 단순 정보 모달.
          별도 확인 버튼 없이 상단 제목열 오른쪽 X로만 닫는다. */}
      {vaultInfoModalOpen && (
        <>
          <div
            onClick={closeVaultInfoModal}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0,0,0,0.45)",
              zIndex: 39,
              opacity: vaultInfoModalVisible ? 1 : 0,
              transition: "opacity 0.2s ease",
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: vaultInfoModalVisible ? "translate(-50%, -50%) scale(1)" : "translate(-50%, -50%) scale(0.92)",
              opacity: vaultInfoModalVisible ? 1 : 0,
              background: isLight ? "#FFFFFF" : "#1a1918",
              borderRadius: 20,
              border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
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
                onClick={closeVaultInfoModal}
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
                { label: "이름", value: vaultInfoTarget ? vaultInfoTarget.name : "-" },
                { label: "생성 일자", value: vaultInfoTarget ? formatDate(vaultInfoTarget.createdAt) : "-" },
                { label: "수정 일자", value: vaultInfoTarget ? formatDate(vaultInfoTarget.updatedAt) : "-" },
                { label: "크기", value: vaultInfoTarget ? formatFileSize(vaultTotalBytes(vaultInfoTarget.name)) : "-" },
              ].map((row) => (
                <div key={row.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ color: isLight ? "rgba(20,22,26,0.5)" : "rgba(255,255,255,0.5)", fontSize: 15 }}>
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
              border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
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
                border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
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
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
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
              borderRadius: 16,
              border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
              padding: "24px 30px",
              width: "84vw",
              boxSizing: "border-box",
              maxHeight: "70vh",
              display: "flex",
              flexDirection: "column",
              zIndex: 40,
              boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
              transition: "opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1), transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              style={{
                margin: "0 0 4px 0",
                fontSize: 19,
                fontWeight: 700,
                color: isLight ? "#14161A" : "#FFFFFF",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {moveTarget ? `"${moveTarget.name}" 이동` : "이동"}
            </h2>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 4,
                margin: "12px 0",
                paddingBottom: 12,
                borderBottom: `1px solid ${isLight ? "rgba(20,22,26,0.12)" : "rgba(255,255,255,0.12)"}`,
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
                  <span style={{ color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)", fontSize: 14 }}>&gt;</span>
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

            <div style={{ flex: 1, overflowY: "auto", minHeight: 80, marginBottom: 16 }}>
              {moveModalEntries.length === 0 ? (
                <div
                  style={{
                    padding: "24px 0",
                    textAlign: "center",
                    color: isLight ? "rgba(20,22,26,0.35)" : "rgba(255,255,255,0.35)",
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

            <div style={{ display: "flex", gap: 12 }}>
              <button
                onClick={closeMoveModal}
                onMouseDown={pressDown("scale(0.95)")}
                onMouseUp={pressUp("scale(1)")}
                style={{
                  flex: 1,
                  padding: 10,
                  border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
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
                onClick={confirmMove}
                disabled={!canDropHere}
                onMouseDown={canDropHere ? pressDown("scale(0.95)") : undefined}
                onMouseUp={canDropHere ? pressUp("scale(1)") : undefined}
                style={{
                  flex: 1,
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
                여기로 이동
              </button>
            </div>
          </div>
        </>
      )}

      {/* 하단 컨트롤 영역 - 검색 버튼의 오른쪽 끝이 상단 + 버튼과 동일하게 화면 우측에서 20px
          지점에 오도록 오른쪽 정렬한다(상단 헤더도 좌우 20px 인셋을 쓴다). */}
      <div
        style={{
          position: "fixed",
          bottom: 24,
          right: 20,
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        {/* 리퀴드 글래스 탭바 */}
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: BAR_HEIGHT,
            padding: "0 8px",
            borderRadius: 999,
            flexShrink: 0,
            background: isLight ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.06)",
            backdropFilter: "blur(20px) saturate(180%)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            border: `1px solid ${isLight ? "rgba(20,22,26,0.12)" : "rgba(255,255,255,0.12)"}`,
            boxShadow:
              "0 8px 32px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255,255,255,0.08)",
          }}
        >
          {/* 이동하는 선택 인디케이터 */}
          <div
            style={{
              position: "absolute",
              top: 8,
              left: indicator.left,
              width: indicator.width,
              height: BAR_HEIGHT - 16,
              borderRadius: 999,
              background: isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)",
              boxShadow:
                "0 2px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.25)",
              transition: "left 0.45s cubic-bezier(0.22, 1, 0.36, 1), width 0.45s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          />

          {tabs.map((tab, i) => {
            const isActive = active === i;
            const isHovered = hovered === i;
            return (
              <button
                key={tab}
                ref={(el) => (btnRefs.current[i] = el)}
                onClick={() => setActive(i)}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={(e) => {
                  setHovered(null);
                  e.currentTarget.style.transform = "translateY(0) scale(1)";
                }}
                onMouseDown={(e) => e.currentTarget.style.transform = "translateY(0) scale(0.93)"}
                onMouseUp={pressUp(isHovered && !isActive ? "translateY(-1px) scale(1)" : "translateY(0) scale(1)")}
                onTouchStart={(e) => e.currentTarget.style.transform = "translateY(0) scale(0.93)"}
                onTouchEnd={pressUp("translateY(0) scale(1)")}
                style={{
                  position: "relative",
                  zIndex: 1,
                  minWidth: 76,
                  height: BAR_HEIGHT - 16,
                  padding: "0 28px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "none",
                  background: isHovered && !isActive
                    ? (isLight ? "rgba(20,22,26,0.06)" : "rgba(255,255,255,0.06)")
                    : "transparent",
                  borderRadius: 999,
                  color: isActive
                    ? (isLight ? "#14161A" : "#FFFFFF")
                    : isHovered
                    ? (isLight ? "rgba(20,22,26,0.85)" : "rgba(255,255,255,0.85)")
                    : (isLight ? "rgba(20,22,26,0.55)" : "rgba(255,255,255,0.55)"),
                  fontSize: 15,
                  fontWeight: isActive ? 600 : 500,
                  letterSpacing: 0.2,
                  cursor: "pointer",
                  transition:
                    "color 0.3s ease, background 0.3s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
                  transform: isHovered && !isActive ? "translateY(-1px) scale(1)" : "translateY(0) scale(1)",
                  outline: "none",
                }}
              >
                {i === 0 ? (
                  // 홈 탭
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 3.2 3 10.5V20a1 1 0 0 0 1 1h5.5v-6.5h5V21H19a1 1 0 0 0 1-1v-9.5L12 3.2z" />
                  </svg>
                ) : i === 1 ? (
                  // 커뮤니티 탭
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-4.4 3.7A0.6 0.6 0 0 1 3.6 20V6a1 1 0 0 1 1-1z" />
                  </svg>
                ) : (
                  // 설정 탭
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="8" r="3.6" />
                    <path d="M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1z" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>

        {/* 검색 버튼 (리퀴드 글래스, 탭바와 동일한 높이의 원형) - 누르면 탭바 위에 검색창 패널이 열린다 */}
        <button
          onClick={toggleSearch}
          onMouseEnter={() => setSearchButtonHovered(true)}
          onMouseLeave={(e) => {
            setSearchButtonHovered(false);
            e.currentTarget.style.transform = "scale(1)";
          }}
          onMouseDown={pressDown("scale(0.9)")}
          onMouseUp={pressUp(searchButtonHovered ? "scale(1.08)" : "scale(1)")}
          onTouchStart={pressDown("scale(0.9)")}
          onTouchEnd={pressUp("scale(1)")}
          aria-label="검색창 열기"
          style={{
            width: BAR_HEIGHT,
            height: BAR_HEIGHT,
            flexShrink: 0,
            borderRadius: "50%",
            border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
            background: searchButtonHovered
              ? (isLight ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.14)")
              : (isLight ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.06)"),
            backdropFilter: "blur(20px) saturate(180%)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            boxShadow: searchButtonHovered
              ? "0 10px 36px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.3)"
              : "0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08)",
            color: isLight ? "#14161A" : "#FFFFFF",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            outline: "none",
            transition:
              "background 0.3s ease, box-shadow 0.3s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)",
            transform: searchButtonHovered ? "scale(1.08)" : "scale(1)",
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </button>
      </div>

      {/* 검색창 패널 (리퀴드 글래스) - 탭바와 동일한 디자인 위에 검색 플레이스홀더 입력창 하나만 있다.
          입력창 폰트 크기를 16px 이상으로 둬야 iOS 사파리가 포커스 시 화면을 자동 확대하지 않는다. */}
      {searchOpen && (
        <>
          <div onClick={toggleSearch} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 9 }} />
          <div
            style={{
              position: "fixed",
              bottom: 24 + BAR_HEIGHT + 14,
              left: "50%",
              zIndex: 10,
              width: "min(360px, 88vw)",
              opacity: searchVisible ? 1 : 0,
              transform: searchVisible
                ? "translate(-50%, 0)"
                : "translate(-50%, 16px)",
              transition:
                "opacity 0.3s cubic-bezier(0.22, 1, 0.36, 1), transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: 12,
                borderRadius: 26,
                background: isLight ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.08)",
                backdropFilter: "blur(28px) saturate(180%)",
                WebkitBackdropFilter: "blur(28px) saturate(180%)",
                border: `1px solid ${isLight ? "rgba(20,22,26,0.14)" : "rgba(255,255,255,0.14)"}`,
                boxShadow:
                  "0 20px 60px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255,255,255,0.12)",
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ color: isLight ? "rgba(20,22,26,0.45)" : "rgba(255,255,255,0.45)", flexShrink: 0, marginLeft: 4 }}
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="검색"
                aria-label="검색"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  fontSize: 17,
                  fontWeight: 500,
                  color: isLight ? "#14161A" : "#FFFFFF",
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
