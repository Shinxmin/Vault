-- Vaulty 데이터(Vault/폴더/파일 목록)를 위한 테이블.
-- 로그인 기능이 없는 개인용 앱이라 행을 하나만 두고(id='default') 전체 상태를 통째로 저장한다.
-- 실제 파일 바이트는 Cloudflare R2에 있고, files.r2_key로 R2 객체를 가리킨다.
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요.
create table if not exists public.vaulty_state (
  id text primary key default 'default',
  vaults jsonb not null default '[]'::jsonb,
  folders jsonb not null default '[]'::jsonb,
  files jsonb not null default '[]'::jsonb,
  custom_order_active boolean not null default false,
  trash jsonb not null default '[]'::jsonb,
  storage_limit_gb numeric not null default 10,
  nickname text not null default '사용자',
  community_posts jsonb not null default '[]'::jsonb,
  imported_vaults jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- 기존에 테이블이 이미 있는 환경에서는 아래 줄들만 실행해도 됩니다.
alter table public.vaulty_state add column if not exists custom_order_active boolean not null default false;
-- 휴지통(삭제 후 7일간 보관되는 Vault/폴더/파일) 저장용 컬럼.
alter table public.vaulty_state add column if not exists trash jsonb not null default '[]'::jsonb;
-- 저장 공간 한도(GB) - 설정 탭의 "한도 설정"에서 직접 늘려서 설정할 수 있다.
alter table public.vaulty_state add column if not exists storage_limit_gb numeric not null default 10;
-- 프로필 닉네임 - 설정 탭의 "프로필" 카드에서 연필 아이콘으로 수정한다.
alter table public.vaulty_state add column if not exists nickname text not null default '사용자';
-- 커뮤니티 게시글("게시판") 목록.
alter table public.vaulty_state add column if not exists community_posts jsonb not null default '[]'::jsonb;
-- 게시글/텍스트문서의 Vaulty@주소 링크를 눌러 "가져온" Vault 참조 목록(원본은 그대로 두고 읽기 전용 접근만 기록).
alter table public.vaulty_state add column if not exists imported_vaults jsonb not null default '[]'::jsonb;

alter table public.vaulty_state enable row level security;

-- 로그인이 없으므로 anon 키로 이 한 행만 자유롭게 읽고 쓸 수 있게 허용한다.
drop policy if exists "Anyone can read vaulty state" on public.vaulty_state;
create policy "Anyone can read vaulty state"
  on public.vaulty_state for select
  using (true);

drop policy if exists "Anyone can upsert vaulty state" on public.vaulty_state;
create policy "Anyone can upsert vaulty state"
  on public.vaulty_state for insert
  with check (true);

drop policy if exists "Anyone can update vaulty state" on public.vaulty_state;
create policy "Anyone can update vaulty state"
  on public.vaulty_state for update
  using (true);

-- ── 로그인(v0.1.57) ──────────────────────────────────────────────────────
-- 개인 웹사이트라 회원가입 화면은 없다 - Supabase 대시보드(Authentication > Users)에
-- 미리 등록해 둔 계정으로만 로그인할 수 있다. vaulty_state의 각 행이 로그인 계정
-- (auth.users)에 연결되며, 기존에 로그인 없이 쓰던 'default' 행은 그대로 두고 그
-- 계정이 처음 로그인하는 순간 앱 코드가 이 컬럼을 채워 "내 데이터"로 자동으로
-- 이어받는다(수동으로 연결해야 한다면 아래 UPDATE 문 참고).
alter table public.vaulty_state add column if not exists user_id uuid references auth.users(id);
create unique index if not exists vaulty_state_user_id_key on public.vaulty_state(user_id) where user_id is not null;

-- 참고 - 'default' 행을 특정 계정에 수동으로 즉시 연결하고 싶다면(자동 연결을 기다리지
-- 않고) 아래처럼 실행할 수 있습니다. YOUR_EMAIL 부분만 실제 등록한 이메일로 바꾸세요.
-- update public.vaulty_state
--   set user_id = (select id from auth.users where email = 'YOUR_EMAIL')
--   where id = 'default';

-- (v0.1.69에서 쓰던 % 인풋 컬럼 - 지금은 스위치 2개(원본/최적화)로 바뀌어 더 쓰이지
-- 않지만, 기존 배포 호환을 위해 컬럼 자체는 그대로 둔다.)
alter table public.vaulty_state add column if not exists upload_compress_percent numeric not null default 100;
-- 업로드 방식 - 설정 탭의 "업로드" 카드에서 원본/최적화 스위치로 고른다. true(최적화)면
-- 이미지/움짤만 원본 해상도의 50%로 줄여서 R2에 올린다. false(기본값, 원본)면 그대로 올라간다.
alter table public.vaulty_state add column if not exists upload_optimize_enabled boolean not null default false;
