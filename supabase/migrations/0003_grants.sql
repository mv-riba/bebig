-- 0003: explicit API privileges. Newer Supabase projects may not grant new tables to the API roles automatically.
-- Safe: row-level security (0001) still decides which rows each user can see or change.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.profiles, public.baby_profiles, public.baby_access, public.feeding_entries, public.poo_entries,
  public.sleep_entries, public.growth_measurements, public.ai_insights, public.ai_conversations, public.ai_conversation_messages
  to authenticated;
grant execute on function public.respond_invitation(uuid, boolean), public.delete_my_account(), public.is_member(uuid), public.is_owner(uuid) to authenticated;
