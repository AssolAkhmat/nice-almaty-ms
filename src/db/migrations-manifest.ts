/*
 * Список миграций, известных этой сборке. Файл создаётся скриптом
 * `scripts/write-migrations-manifest.mjs` и обновляется вместе с новой
 * миграцией: руками его не правят.
 *
 * Он нужен проверке версии схемы при старте: приложение сравнивает свой
 * список с тем, что применено в базе, и падает понятной ошибкой, если
 * миграции забыли накатить.
 */
export const MIGRATIONS = [
  '0000_giant_korg.sql',
  '0001_productive_paper_doll.sql',
  '0002_parched_hannibal_king.sql',
  '0003_aspiring_mathemanic.sql',
  '0004_lock_down_supabase_data_api.sql',
  '0005_fuzzy_ogun.sql',
  '0006_free_texas_twister.sql',
  '0007_wide_tony_stark.sql',
  '0008_woozy_green_goblin.sql',
  '0009_left_forgotten_one.sql',
  '0010_clean_masked_marvel.sql',
  '0011_milky_zaladane.sql',
  '0012_ledger_expense_category.sql',
  '0013_house_files_and_expense_receipt.sql',
  '0014_overconfident_lorna_dane.sql',
  '0015_supreme_the_enforcers.sql',
  '0016_clever_the_phantom.sql',
  '0017_productive_adam_destine.sql',
  '0018_glorious_wilson_fisk.sql',
  '0019_calm_alex_wilder.sql',
  '0020_steady_manta.sql',
] as const;

export const EXPECTED_MIGRATIONS = MIGRATIONS.length;
