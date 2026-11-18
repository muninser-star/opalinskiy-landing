-- Add server-side continuation and one-recipient Telegram delivery to the existing job tables.
begin;

create table public.transcript_telegram_codes (
  code_hash text primary key,
  chat_id bigint not null,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  check (code_hash ~ '^[0-9a-f]{64}$')
);

create table public.transcript_telegram_bindings (
  id uuid primary key default gen_random_uuid(),
  browser_hash text not null check (browser_hash ~ '^[0-9a-f]{64}$'),
  chat_id bigint not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index transcript_telegram_active_browser
  on public.transcript_telegram_bindings (browser_hash) where revoked_at is null;

alter table public.transcription_jobs
  add column if not exists original_name text,
  add column if not exists provider_result_duration double precision,
  add column if not exists provider_result_saved boolean not null default false,
  add column if not exists retry_count smallint not null default 0,
  add column if not exists retry_at timestamptz,
  add column if not exists telegram_binding_id uuid references public.transcript_telegram_bindings(id);

alter table public.meeting_summaries
  add column if not exists retry_count smallint not null default 0,
  add column if not exists retry_at timestamptz,
  add column if not exists telegram_binding_id uuid references public.transcript_telegram_bindings(id);

create table public.transcript_telegram_deliveries (
  kind text not null check (kind in ('transcript', 'summary')),
  job_id uuid not null,
  binding_id uuid not null references public.transcript_telegram_bindings(id),
  state text not null default 'pending' check (state in ('pending','sending','sent','failed','unknown','cancelled')),
  attempts smallint not null default 0,
  next_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  telegram_message_id bigint,
  primary key (kind, job_id)
);

create index transcript_telegram_ready
  on public.transcript_telegram_deliveries (next_at) where state in ('pending', 'sending');
create index transcript_background_active
  on public.transcription_jobs (updated_at) where state in ('submitting', 'processing');
create index transcript_summary_active
  on public.meeting_summaries (updated_at) where state = 'processing';

alter table public.transcript_telegram_codes enable row level security;
alter table public.transcript_telegram_bindings enable row level security;
alter table public.transcript_telegram_deliveries enable row level security;
revoke all on public.transcript_telegram_codes, public.transcript_telegram_bindings,
  public.transcript_telegram_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.transcript_telegram_codes, public.transcript_telegram_bindings,
  public.transcript_telegram_deliveries to service_role;

create or replace function public.link_transcript_telegram(p_browser_hash text, p_code_hash text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  target_chat bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_browser_hash, 0));
  delete from public.transcript_telegram_codes
  where code_hash = p_code_hash and expires_at > now()
  returning chat_id into target_chat;
  if not found then return false; end if;
  if not exists (
    select 1 from public.family_bot_profiles
    where owner_id = target_chat and chat_id = target_chat and active
  ) then return false; end if;
  update public.transcript_telegram_bindings set revoked_at = now()
  where browser_hash = p_browser_hash and revoked_at is null and chat_id <> target_chat;
  insert into public.transcript_telegram_bindings (browser_hash, chat_id)
  values (p_browser_hash, target_chat)
  on conflict (browser_hash) where revoked_at is null do nothing;
  return true;
end;
$$;

revoke all on function public.link_transcript_telegram(text, text) from public, anon, authenticated;
grant execute on function public.link_transcript_telegram(text, text) to service_role;

create or replace function public.enqueue_transcript_telegram_delivery()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.transcript_telegram_deliveries (kind, job_id, binding_id)
  values (tg_argv[0], new.id, new.telegram_binding_id)
  on conflict do nothing;
  return new;
end;
$$;

revoke all on function public.enqueue_transcript_telegram_delivery() from public, anon, authenticated;
grant execute on function public.enqueue_transcript_telegram_delivery() to service_role;

create trigger transcript_completed_telegram
after update on public.transcription_jobs
for each row when (new.state = 'completed' and new.telegram_binding_id is not null
  and (old.state is distinct from new.state or old.telegram_binding_id is distinct from new.telegram_binding_id))
execute function public.enqueue_transcript_telegram_delivery('transcript');

create trigger meeting_summary_completed_telegram
after update on public.meeting_summaries
for each row when (new.state = 'completed' and new.telegram_binding_id is not null
  and (old.state is distinct from new.state or old.telegram_binding_id is distinct from new.telegram_binding_id))
execute function public.enqueue_transcript_telegram_delivery('summary');

-- This key lives in Vault and is never returned from the API.
select vault.create_secret(
  replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  'transcript_background_cron_secret'
)
where not exists (select 1 from vault.secrets where name = 'transcript_background_cron_secret');

create or replace function public.verify_transcript_background_secret(p_secret text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'transcript_background_cron_secret'
      and decrypted_secret = p_secret
  );
$$;

revoke all on function public.verify_transcript_background_secret(text) from public, anon, authenticated;
grant execute on function public.verify_transcript_background_secret(text) to service_role;


-- Reuse the existing admission rules and lock keys, binding delivery in the same transaction.
create or replace function public.reserve_transcript_background(
  p_id uuid, p_access_hash text, p_browser_hash text
) returns text
language plpgsql
set search_path = ''
as $$
declare
  outcome text;
begin
  outcome := public.reserve_transcription_guest_submission(p_id, p_access_hash);
  if outcome = 'ready' and p_browser_hash is not null then
    update public.transcription_jobs set telegram_binding_id = (
      select id from public.transcript_telegram_bindings
      where browser_hash = p_browser_hash and revoked_at is null
    ) where id = p_id;
  end if;
  return outcome;
end;
$$;

create or replace function public.reserve_summary_background(
  p_id uuid, p_access_hash text, p_client_hash text, p_input_hash text,
  p_input jsonb, p_total_steps integer, p_browser_hash text
) returns text
language plpgsql
set search_path = ''
as $$
declare
  outcome text;
  already_exists boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(662481218);
  select exists (select 1 from public.meeting_summaries where id = p_id) into already_exists;
  outcome := public.reserve_meeting_summary(p_id, p_access_hash, p_client_hash, p_input_hash, p_input, p_total_steps);
  if outcome = 'ready' and not already_exists and p_browser_hash is not null then
    update public.meeting_summaries set telegram_binding_id = (
      select id from public.transcript_telegram_bindings
      where browser_hash = p_browser_hash and revoked_at is null
    ) where id = p_id;
  end if;
  return outcome;
end;
$$;

revoke all on function public.reserve_transcript_background(uuid,text,text) from public, anon, authenticated;
revoke all on function public.reserve_summary_background(uuid,text,text,text,jsonb,integer,text) from public, anon, authenticated;
grant execute on function public.reserve_transcript_background(uuid,text,text) to service_role;
grant execute on function public.reserve_summary_background(uuid,text,text,text,jsonb,integer,text) to service_role;

commit;
