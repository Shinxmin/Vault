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
