-- Journal: strategy-aware annotation
-- (Strategy-Aware Journaling foundation, branch feature/dr-trade-capture)
--
-- Additive and backward-compatible: every column below is new;
-- existing production code ignores them, and existing rows keep
-- working (all new columns stay NULL = "not recorded", never
-- back-filled or invented — legacy hod_class values are mapped
-- forward at READ time only, in lib/strategyClassification.ts).
--
--   strategies.classification_family  text — classification family
--     for the strategy (see ClassificationFamily in
--     lib/strategyClassification.ts); NULL = "not recorded", with
--     the family derived at read time from the latest version when
--     needed, never written back.
--   journal_trade_meta.setup_class    text — per-trade classification
--     slug for the trade's family. Deliberately NO check constraint:
--     the vocabulary lives in lib/strategyClassification.ts and
--     evolves without a migration per change; unknown slugs pass
--     through on read.
--   journal_trade_meta.strategy_custom_label  text — free-text label
--     when the trader records a custom / experimental classification.
--   journal_trade_meta.entry_trigger  text — what triggered the
--     entry, as recorded by the trader.
--   journal_trade_meta.strategy_id    uuid — the ONE strategy
--     registry entry (public.strategies) this trade is annotated
--     against; NULL = "no strategy recorded". The foreign key is
--     added in the guarded DO block below, not inline: schema.sql's
--     scratch baseline creates journal_trade_meta before the
--     strategies table exists, so an inline FK would fail there.
--   strategies_annotation_unique        partial unique index —
--     database-level duplicate protection for annotation
--     materialization; see the index block at the end of this file.
--
-- RLS is unchanged: journal_trade_meta and strategies already
-- restrict rows to their owner, and the new columns inherit the
-- tables' owner policies.

alter table public.strategies
  add column if not exists classification_family text;

alter table public.journal_trade_meta
  add column if not exists setup_class text,
  add column if not exists strategy_custom_label text,
  add column if not exists entry_trigger text,
  add column if not exists strategy_id uuid;

do $$
begin
  alter table public.journal_trade_meta
    add constraint journal_trade_meta_strategy_id_fkey
    foreign key (strategy_id) references public.strategies(id) on delete set null;
exception when duplicate_object then null;
end $$;

-- Duplicate protection for strategy materialization (safety-audit
-- remediation, check 3a): the app's (family, lower(name)) guard in
-- lib/strategyClassification.ts runs over a client-held snapshot, so
-- two concurrent saves could both miss it and insert the same
-- strategy twice. This partial unique index mirrors the guard
-- EXACTLY at the database level: annotation-materialized strategies
-- always carry a classification_family and must be unique per
-- (user_id, classification_family, lower(name)). Rows created the
-- Daily Replay way have classification_family NULL and stay outside
-- the index (Postgres also treats NULLs as distinct), so they can
-- neither collide nor block creation. At apply time every existing
-- strategies row has classification_family NULL (the column is
-- added by this same file), so creating this index cannot fail on
-- existing data. 'if not exists' keeps the file re-runnable; the
-- app resolves a unique-violation on insert by re-fetching and
-- reusing the winning row (resolveTradedStrategyId).
create unique index if not exists strategies_annotation_unique
  on public.strategies (user_id, classification_family, lower(name))
  where classification_family is not null;
