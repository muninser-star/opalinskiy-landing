-- The initial meeting summary remains the immutable Telegram document.
alter table public.meeting_summaries
  add column question_revisions jsonb not null default '[]'::jsonb,
  add column question_version integer not null default 0;

create index meeting_summary_question_expiry
  on public.meeting_summaries (created_at)
  where state = 'completed' and (input is not null or question_version <> 0);

create table public.transcript_question_rate (
  bucket timestamptz not null,
  rate_key text not null,
  requests integer not null,
  primary key (bucket, rate_key)
);
alter table public.transcript_question_rate enable row level security;
revoke all on table public.transcript_question_rate from public, anon, authenticated;
grant select, insert, update on table public.transcript_question_rate to service_role;

create function public.reserve_transcript_question(p_job_key text, p_client_hash text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $body$
declare
  hour_start timestamptz := date_trunc('hour', now());
begin
  -- Serialize the small quota check and counter increments across all callers.
  perform pg_advisory_xact_lock(662481219);
  if exists (
    select 1 from public.transcript_question_rate r
    where r.bucket = hour_start and (
      (r.rate_key = 'overall' and r.requests >= 180) or
      (r.rate_key = 'job:' || p_job_key and r.requests >= 24) or
      (r.rate_key = 'client:' || p_client_hash and r.requests >= 48)
    )
  ) then
    return false;
  end if;
  insert into public.transcript_question_rate as r(bucket, rate_key, requests)
  values (hour_start, 'overall', 1), (hour_start, 'job:' || p_job_key, 1),
    (hour_start, 'client:' || p_client_hash, 1)
  on conflict (bucket, rate_key) do update set requests = r.requests + 1;
  return true;
end;
$body$;

revoke all on function public.reserve_transcript_question(text, text) from public, anon, authenticated;
grant execute on function public.reserve_transcript_question(text, text) to service_role;

select cron.schedule('transcript-questions-expiry', '* * * * *', $cleanup$
  update public.meeting_summaries
  set input = null, question_revisions = '[]'::jsonb, question_version = 0
  where state = 'completed' and created_at <= now() - interval '24 hours'
    and (input is not null or question_version <> 0);
  delete from public.transcript_question_rate where bucket < date_trunc('hour', now()) - interval '1 hour';
$cleanup$);
