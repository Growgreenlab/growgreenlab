-- Journal: key levels & trade context + original plan preservation
-- (Trade Journal UX / Trade DNA round, branch journal-ux-key-levels)
--
-- Additive and backward-compatible: all four columns are new on
-- journal_trade_meta; existing production code ignores them, and
-- existing rows keep working (key_levels/plan_history default to
-- empty arrays; originals stay NULL = "plan not recorded", never
-- back-filled or invented).
--
--   key_levels          jsonb  — [{price, type, interaction, notes}]
--   original_stop_loss  numeric — set-once original planned stop
--   original_target     numeric — set-once original planned target
--   plan_history        jsonb  — [{at, field, from, to}] change log
--
-- RLS is unchanged: journal_trade_meta already restricts rows to
-- their owner (auth.uid() = user_id), and the new columns inherit it.

alter table public.journal_trade_meta
  add column if not exists key_levels jsonb not null default '[]'::jsonb,
  add column if not exists original_stop_loss numeric,
  add column if not exists original_target numeric,
  add column if not exists plan_history jsonb not null default '[]'::jsonb;
