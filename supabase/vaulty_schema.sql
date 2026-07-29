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

-- ── 회원가입/로그인(v0.1.55) ──────────────────────────────────────────────
-- 계정(로그인)이 생기면서 vaulty_state의 각 행이 특정 로그인 계정(auth.users)에
-- 연결된다. 기존에 로그인 없이 쓰던 'default' 행은 그대로 두고, 그 계정이
-- 처음 회원가입하는 순간 앱 코드가 이 컬럼을 채워 "내 데이터"로 이어받는다.
alter table public.vaulty_state add column if not exists user_id uuid references auth.users(id);
create unique index if not exists vaulty_state_user_id_key on public.vaulty_state(user_id) where user_id is not null;

-- 아이디(username) <-> 로그인 계정 매핑. username에 유니크 제약이 걸려 있어
-- 회원가입 시 중복 아이디를 이 테이블로 바로 확인할 수 있다.
-- 이름을 "profiles"가 아니라 "vaulty_profiles"로 둔 이유 - Supabase 프로젝트에
-- 이미 다른 용도의(다른 컬럼 구조를 가진) "profiles" 테이블/뷰가 있는 경우가 흔해서,
-- 이름이 겹치면 create table if not exists가 기존 것을 그대로 두고 넘어가버려
-- 뒤 정책(policy)에서 컬럼이 없다는 에러(42703)가 난다. 겹칠 일이 없는 이름을 쓴다.
create table if not exists public.vaulty_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  created_at timestamptz not null default now()
);

alter table public.vaulty_profiles enable row level security;

drop policy if exists "Anyone can read vaulty profiles" on public.vaulty_profiles;
create policy "Anyone can read vaulty profiles"
  on public.vaulty_profiles for select
  using (true);

drop policy if exists "Users can insert own vaulty profile" on public.vaulty_profiles;
create policy "Users can insert own vaulty profile"
  on public.vaulty_profiles for insert
  with check (auth.uid() = id);

drop policy if exists "Users can update own vaulty profile" on public.vaulty_profiles;
create policy "Users can update own vaulty profile"
  on public.vaulty_profiles for update
  using (auth.uid() = id);
