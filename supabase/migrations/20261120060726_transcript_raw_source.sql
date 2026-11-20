begin;

alter table public.transcription_jobs
  add column source_kind text not null default 'legacy'
    check (source_kind in ('legacy', 'raw')),
  add column piece_offset_seconds double precision not null default 0
    check (piece_offset_seconds >= 0 and piece_offset_seconds < 120),
  add column piece_seconds smallint not null default 120
    check (piece_seconds in (120, 60, 30, 15));

alter table public.transcription_jobs drop constraint transcription_jobs_parts_check;
alter table public.transcription_jobs add constraint transcription_jobs_parts_check check (
  (part_count is null and duration_seconds is null and parts_done = 0
    and (part_lease is null or source_kind = 'raw'))
  or
  (part_count is not null and duration_seconds is not null
    and part_count between 1 and 30 and duration_seconds > 0 and duration_seconds <= 10800
    and part_count = ceil(duration_seconds / 360)
    and parts_done between 0 and part_count and provider_id is null
    and (state <> 'completed' or parts_done = part_count))
);

alter table public.transcription_jobs
  add constraint transcription_jobs_raw_provider_check check (source_kind <> 'raw' or provider_id is null);

commit;
