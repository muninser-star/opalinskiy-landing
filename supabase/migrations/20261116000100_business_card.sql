create schema if not exists business_card_internal;
revoke all on schema business_card_internal from public;
grant usage on schema business_card_internal to anon, authenticated;

create table public.business_card_profile (
  id boolean primary key default true check (id),
  owner_id uuid not null references auth.users(id),
  published boolean not null default true,
  version bigint not null default 1,
  configuration jsonb not null check (
    jsonb_typeof(configuration) = 'object'
    and jsonb_typeof(configuration -> 'fields') = 'array'
    and length(configuration::text) <= 64000
    and length(trim(configuration ->> 'firstName')) between 1 and 100
  )
);

create table public.business_card_public (
  id boolean primary key default true check (id),
  configuration jsonb not null
);

create table public.business_card_inquiries (
  id uuid primary key,
  received_at timestamptz not null default now(),
  name text not null,
  email text not null,
  phone text not null,
  company text not null,
  job text not null,
  message text not null,
  consent_text text not null,
  consent_url text not null
);
create index business_card_inquiries_received_idx on public.business_card_inquiries(received_at desc);

alter table public.business_card_profile enable row level security;
alter table public.business_card_public enable row level security;
alter table public.business_card_inquiries enable row level security;

revoke all on public.business_card_profile, public.business_card_public, public.business_card_inquiries from public, anon, authenticated;
grant select, update (configuration, published) on public.business_card_profile to authenticated;
grant select on public.business_card_public to anon, authenticated;
grant select, delete on public.business_card_inquiries to authenticated;

create policy "Business card owner reads profile"
  on public.business_card_profile for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "Business card owner edits profile"
  on public.business_card_profile for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "Anyone reads published business card"
  on public.business_card_public for select to anon, authenticated
  using (true);
create policy "Business card owner reads inquiries"
  on public.business_card_inquiries for select to authenticated
  using (exists (select 1 from public.business_card_profile where owner_id = (select auth.uid())));
create policy "Business card owner deletes inquiries"
  on public.business_card_inquiries for delete to authenticated
  using (exists (select 1 from public.business_card_profile where owner_id = (select auth.uid())));

create function business_card_internal.publish_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  visible_fields jsonb;
begin
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
  end if;
  if not new.published then
    delete from public.business_card_public where id = new.id;
    return new;
  end if;

  select coalesce(jsonb_agg(f.field order by f.position), '[]'::jsonb)
      into visible_fields
      from jsonb_array_elements(new.configuration -> 'fields') with ordinality as f(field, position)
      where f.field -> 'visible' = 'true'::jsonb;

  insert into public.business_card_public (id, configuration)
    values (new.id, jsonb_set(new.configuration, '{fields}', visible_fields))
    on conflict (id) do update set configuration = excluded.configuration;
  return new;
end;
$$;
revoke all on function business_card_internal.publish_profile() from public, anon, authenticated;
create trigger business_card_publish_profile
  before insert or update on public.business_card_profile
  for each row execute function business_card_internal.publish_profile();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('business-card-files', 'business-card-files', false, 10485760, array[
  'image/jpeg','image/png','image/webp','application/pdf','text/plain','text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/zip'
]);

create policy "Business card owner uploads files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'business-card-files' and
    exists (select 1 from public.business_card_profile where owner_id = (select auth.uid())));
create policy "Business card owner reads files"
  on storage.objects for select to authenticated
  using (bucket_id = 'business-card-files' and
    exists (select 1 from public.business_card_profile where owner_id = (select auth.uid())));
create policy "Business card visitor reads visible files"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'business-card-files' and exists (
    select 1 from public.business_card_public as c
    where name = c.configuration ->> 'photo'
      or name = c.configuration ->> 'cover'
      or exists (select 1 from jsonb_array_elements(c.configuration -> 'fields') as entry(field)
                 where entry.field ->> 'type' = 'file' and entry.field ->> 'value' = name)
  ));

create function business_card_internal.submit_inquiry(
  submission_id uuid, visitor_name text, visitor_email text, visitor_phone text,
  visitor_company text, visitor_job text, visitor_message text, consent boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  settings jsonb;
begin
  select configuration -> 'inquiry' into settings
  from public.business_card_public where id = true;

  if settings -> 'enabled' is distinct from 'true'::jsonb
     or nullif(trim(settings ->> 'consentUrl'), '') is null
     or nullif(trim(settings ->> 'consentText'), '') is null then
    raise exception using message = 'form_disabled', errcode = '22023';
  end if;

  visitor_name := trim(coalesce(visitor_name, ''));
  visitor_email := lower(trim(coalesce(visitor_email, '')));
  visitor_phone := trim(coalesce(visitor_phone, ''));
  visitor_company := trim(coalesce(visitor_company, ''));
  visitor_job := trim(coalesce(visitor_job, ''));
  visitor_message := trim(coalesce(visitor_message, ''));

  if consent is distinct from true or submission_id is null
     or length(visitor_name) not between 1 and 120
     or (visitor_email = '' and visitor_phone = '')
     or (visitor_email <> '' and (length(visitor_email) > 254 or visitor_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'))
     or (visitor_phone <> '' and visitor_phone !~ '^[+0-9 ()-]{6,30}$')
     or length(visitor_company) > 150 or length(visitor_job) > 150 or length(visitor_message) > 2000 then
    raise exception using message = 'invalid_inquiry', errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(428311, 711);
  if exists (select 1 from public.business_card_inquiries where id = submission_id) then
    return;
  end if;
  if (select count(*) from public.business_card_inquiries where received_at > now() - interval '1 minute') >= 12
    or (select count(*) from public.business_card_inquiries where received_at > now() - interval '15 minutes'
      and ((visitor_email <> '' and email = visitor_email) or (visitor_phone <> '' and phone = visitor_phone))) >= 3 then
    raise exception using message = 'rate_limited', errcode = '22023';
  end if;

  insert into public.business_card_inquiries
    (id, name, email, phone, company, job, message, consent_text, consent_url)
    values (submission_id, visitor_name, visitor_email, visitor_phone, visitor_company,
      visitor_job, visitor_message, settings ->> 'consentText', settings ->> 'consentUrl');
end;
$$;
revoke all on function business_card_internal.submit_inquiry(uuid,text,text,text,text,text,text,boolean) from public, anon, authenticated;
grant execute on function business_card_internal.submit_inquiry(uuid,text,text,text,text,text,text,boolean) to anon, authenticated;

create function public.business_card_submit_inquiry(
  submission_id uuid, visitor_name text, visitor_email text, visitor_phone text,
  visitor_company text, visitor_job text, visitor_message text, consent boolean
)
returns void
language sql
security invoker
set search_path = ''
return business_card_internal.submit_inquiry($1,$2,$3,$4,$5,$6,$7,$8);
revoke all on function public.business_card_submit_inquiry(uuid,text,text,text,text,text,text,boolean) from public, anon, authenticated;
grant execute on function public.business_card_submit_inquiry(uuid,text,text,text,text,text,text,boolean) to anon, authenticated;
