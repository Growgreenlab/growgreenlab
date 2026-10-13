-- Journal screenshots storage
-- Applied to production Supabase 2026-10-13 with the journal CRUD work
-- (branch: journal-crud-screenshots). This file is the migration record.
--
-- Creates the PRIVATE bucket `journal-screenshots`. Objects live at
--   {auth.uid()}/{trade_key_segment}/{uuid}-{filename}
-- and the four policies below restrict select/insert/update/delete to
-- objects whose FIRST path segment equals the caller's auth.uid(), so
-- a user can never read or modify another user's screenshots.
-- The app reads screenshots through short-lived signed URLs only.

insert into storage.buckets (id, name, public)
values ('journal-screenshots', 'journal-screenshots', false)
on conflict (id) do nothing;

drop policy if exists "journal screenshots read own" on storage.objects;
create policy "journal screenshots read own"
  on storage.objects for select
  using (
    bucket_id = 'journal-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "journal screenshots insert own" on storage.objects;
create policy "journal screenshots insert own"
  on storage.objects for insert
  with check (
    bucket_id = 'journal-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "journal screenshots update own" on storage.objects;
create policy "journal screenshots update own"
  on storage.objects for update
  using (
    bucket_id = 'journal-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'journal-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "journal screenshots delete own" on storage.objects;
create policy "journal screenshots delete own"
  on storage.objects for delete
  using (
    bucket_id = 'journal-screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
