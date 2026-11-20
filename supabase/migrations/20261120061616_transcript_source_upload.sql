create or replace function public.reserve_transcription_source_upload(
  p_id uuid, p_audio_path text, p_audio_bytes integer, p_access_hash text,
  p_client_hash text, p_source_kind text
) returns text
language plpgsql
set search_path = ''
as $$
declare
  previous_kind text;
  previous_access text;
  outcome text;
begin
  if p_source_kind not in ('raw', 'legacy') then return 'file_conflict'; end if;
  perform pg_advisory_xact_lock(662481217);
  select source_kind,access_hash into previous_kind,previous_access from public.transcription_jobs where id = p_id;
  if found and previous_access is distinct from p_access_hash then return 'forbidden'; end if;
  if found and previous_kind <> p_source_kind then return 'file_conflict'; end if;
  outcome := public.reserve_transcription_guest_upload(
    p_id, p_audio_path, p_audio_bytes, p_access_hash, p_client_hash
  );
  if outcome = 'ready' and previous_kind is null then
    update public.transcription_jobs set source_kind = p_source_kind where id = p_id;
  end if;
  return outcome;
end;
$$;

revoke all on function public.reserve_transcription_source_upload(uuid,text,integer,text,text,text)
  from public, anon, authenticated;
grant execute on function public.reserve_transcription_source_upload(uuid,text,integer,text,text,text) to service_role;
