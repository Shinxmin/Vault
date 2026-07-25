-- Vaulty 데이터(Vault/폴더/파일 목록)를 위한 테이블.
-- 로그인 기능이 없는 개인용 앱이라 행을 하나만 두고(id='default') 전체 상태를 통째로 저장한다.
-- 실제 파일 바이트는 Cloudflare R2에 있고, files.r2_key로 R2 객체를 가리킨다.
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요.
create table if not exists public.vaulty_state (
  id text primary key default 'default',
  vaults jsonb not null default '[]'::jsonb,
  folders jsonb not null default '[]'::jsonb,
  files jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

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
