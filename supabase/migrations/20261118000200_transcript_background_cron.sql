-- Apply after the recording-transcribe worker and family-bot confirm command are deployed.
select cron.schedule('transcript-background-tick', '* * * * *', $transcript_background$
  select net.http_post(
    url := 'https://cuhplpukqhdfutcymtmv.supabase.co/functions/v1/recording-transcribe',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Transcript-Background', decrypted_secret
    ),
    body := '{"tick":true}'::jsonb,
    timeout_milliseconds := 5000
  )
  from vault.decrypted_secrets
  where name = 'transcript_background_cron_secret'
    and (
      exists (select 1 from public.transcription_jobs where state in ('submitting', 'processing'))
      or exists (select 1 from public.meeting_summaries where state = 'processing'
        and created_at > now() - interval '1 day')
      or exists (select 1 from public.transcript_telegram_deliveries where state in ('pending', 'sending'))
      or extract(minute from now()) = 0
    );
$transcript_background$);
