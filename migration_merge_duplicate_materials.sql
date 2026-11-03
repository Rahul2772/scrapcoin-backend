-- =============================================================================
-- Merge duplicate materials (2026-11-04)
--   Mixed Plastics  + Mix Plastics    -> Mixed Plastics
--   Used clothes    + TEXTILES        -> Used Clothes
--   Metal E-waste   + METAL E WASTE   -> Metal E-Waste
-- Final names match the public rate card (frontend_scrapco/src/lib/rates.ts).
--
-- Run each STEP on its own in a NEW Supabase SQL tab.
-- The kept row is the catalogue SKU (not "Miscellaneous"), then the one with
-- more purchase lines. Every row in every table that points to a duplicate is
-- moved to the kept row, stock is added together, and the duplicate is deleted.
-- Old names are saved as aliases so Telegram receipts map to the kept SKU.
-- =============================================================================


-- ── STEP 1: PREVIEW (read-only) ─────────────────────────────────────────────
-- Expect 6 rows (3 groups x 2). Check the "role" column shows one KEEP per group.
WITH mats AS (
  SELECT m.*,
         CASE regexp_replace(lower(m.name), '[^a-z0-9]', '', 'g')
           WHEN 'mixedplastics' THEN 'Mixed Plastics'
           WHEN 'mixplastics'   THEN 'Mixed Plastics'
           WHEN 'usedclothes'   THEN 'Used Clothes'
           WHEN 'textiles'      THEN 'Used Clothes'
           WHEN 'metalewaste'   THEN 'Metal E-Waste'
         END AS final_name,
         (SELECT count(*) FROM erp_purchase_receipts r WHERE r.material_id = m.id) AS receipt_lines,
         (SELECT coalesce(sum(weight), 0) FROM erp_purchase_receipts r WHERE r.material_id = m.id) AS kg_bought,
         (SELECT count(*) FROM erp_transactions t WHERE t.material_id = m.id) AS sale_lines,
         (SELECT coalesce(sum(weight), 0) FROM erp_transactions t WHERE t.material_id = m.id) AS kg_sold
  FROM erp_materials m
), ranked AS (
  SELECT *, row_number() OVER (
           PARTITION BY final_name
           ORDER BY (category = 'Miscellaneous'), receipt_lines DESC, created_at) AS rn
  FROM mats WHERE final_name IS NOT NULL
)
SELECT final_name, CASE WHEN rn = 1 THEN 'KEEP' ELSE 'merge into keep' END AS role,
       name, category, unit, stock_qty, receipt_lines, kg_bought, sale_lines, kg_sold, is_active
FROM ranked ORDER BY final_name, rn;


-- ── STEP 2: BACKUP + MERGE (one transaction) ─────────────────────────────────
-- If Supabase shows "Potential issues", choose "Run without RLS"; Step 3 turns
-- RLS on for the new backup tables.
BEGIN;

-- 2a. Which row is kept and which are merged
DROP TABLE IF EXISTS material_merge_map_20261104;
CREATE TABLE material_merge_map_20261104 AS
WITH mats AS (
  SELECT m.id, m.name, m.category, m.created_at,
         CASE regexp_replace(lower(m.name), '[^a-z0-9]', '', 'g')
           WHEN 'mixedplastics' THEN 'Mixed Plastics'
           WHEN 'mixplastics'   THEN 'Mixed Plastics'
           WHEN 'usedclothes'   THEN 'Used Clothes'
           WHEN 'textiles'      THEN 'Used Clothes'
           WHEN 'metalewaste'   THEN 'Metal E-Waste'
         END AS final_name,
         (SELECT count(*) FROM erp_purchase_receipts r WHERE r.material_id = m.id) AS receipt_lines
  FROM erp_materials m
), ranked AS (
  SELECT *, row_number() OVER (
           PARTITION BY final_name
           ORDER BY (category = 'Miscellaneous'), receipt_lines DESC, created_at) AS rn
  FROM mats WHERE final_name IS NOT NULL
)
SELECT d.id AS dup_id, d.name AS dup_name, k.id AS keep_id, k.name AS keep_name, k.final_name
FROM ranked d JOIN ranked k ON k.final_name = d.final_name AND k.rn = 1
WHERE d.rn > 1;

-- 2b. Full copy of the materials table
DROP TABLE IF EXISTS erp_materials_backup_20261104;
CREATE TABLE erp_materials_backup_20261104 AS SELECT * FROM erp_materials;

-- 2c. Old aliases column (Telegram matching reads it)
ALTER TABLE erp_materials ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';

-- 2d. Move every reference in every table that has a foreign key to erp_materials,
--     recording each moved row so it can be rolled back.
DROP TABLE IF EXISTS material_merge_refs_backup_20261104;
CREATE TABLE material_merge_refs_backup_20261104 (
  table_name      TEXT NOT NULL,
  column_name     TEXT NOT NULL,
  row_id          TEXT NOT NULL,
  old_material_id UUID NOT NULL
);

DO $$
DECLARE
  fk RECORD;
  moved INT;
BEGIN
  FOR fk IN
    SELECT kcu.table_schema, kcu.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'erp_materials' AND ccu.column_name = 'id'
  LOOP
    EXECUTE format(
      'INSERT INTO material_merge_refs_backup_20261104
         SELECT %L, %L, t.id::text, t.%I FROM %I.%I t
         JOIN material_merge_map_20261104 m ON t.%I = m.dup_id',
      fk.table_name, fk.column_name, fk.column_name, fk.table_schema, fk.table_name, fk.column_name);
    EXECUTE format(
      'UPDATE %I.%I t SET %I = m.keep_id FROM material_merge_map_20261104 m WHERE t.%I = m.dup_id',
      fk.table_schema, fk.table_name, fk.column_name, fk.column_name);
    GET DIAGNOSTICS moved = ROW_COUNT;
    RAISE NOTICE 'Moved % row(s) in %.%', moved, fk.table_name, fk.column_name;
  END LOOP;
END $$;

-- 2e. "KGS" -> "kg" on the moved lines so units read the same
UPDATE erp_purchase_receipts SET unit = 'kg'
WHERE upper(unit) = 'KGS'
  AND id::text IN (SELECT row_id FROM material_merge_refs_backup_20261104 WHERE table_name = 'erp_purchase_receipts');
UPDATE erp_transactions SET unit = 'kg'
WHERE upper(unit) = 'KGS'
  AND id::text IN (SELECT row_id FROM material_merge_refs_backup_20261104 WHERE table_name = 'erp_transactions');

-- 2f. Add the duplicates' stock and names to the kept row
UPDATE erp_materials k SET
  stock_qty  = k.stock_qty + s.dup_stock,
  aliases    = coalesce((SELECT array_agg(DISTINCT a) FROM unnest(k.aliases || s.dup_names || ARRAY[k.name]) a
                WHERE a <> m.final_name), '{}'),
  updated_at = NOW()
FROM (
  SELECT mm.keep_id, sum(d.stock_qty) AS dup_stock, array_agg(d.name) AS dup_names
  FROM material_merge_map_20261104 mm JOIN erp_materials d ON d.id = mm.dup_id
  GROUP BY mm.keep_id
) s
JOIN (SELECT DISTINCT keep_id, final_name FROM material_merge_map_20261104) m ON m.keep_id = s.keep_id
WHERE k.id = s.keep_id;

-- 2g. Delete the duplicates (nothing points to them any more), then use the rate-card name
DELETE FROM erp_materials WHERE id IN (SELECT dup_id FROM material_merge_map_20261104);
UPDATE erp_materials k SET name = m.final_name, unit = CASE WHEN upper(k.unit) = 'KGS' THEN 'kg' ELSE k.unit END
FROM (SELECT DISTINCT keep_id, final_name FROM material_merge_map_20261104) m
WHERE k.id = m.keep_id;

-- 2h. Weighted average buy cost from all lines now on the kept row
UPDATE erp_materials k SET avg_cost_per_unit = s.avg
FROM (
  SELECT material_id, round(sum(total_amount) / nullif(sum(weight), 0), 2) AS avg
  FROM erp_purchase_receipts
  WHERE material_id IN (SELECT keep_id FROM material_merge_map_20261104)
  GROUP BY material_id
) s
WHERE k.id = s.material_id AND s.avg IS NOT NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ── STEP 3: LOCK DOWN BACKUPS + VERIFY ──────────────────────────────────────
ALTER TABLE material_merge_map_20261104         ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_materials_backup_20261104       ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_merge_refs_backup_20261104 ENABLE ROW LEVEL SECURITY;

-- Expect 3 rows; stock_after = sum of the two old stocks from Step 1.
SELECT m.name, m.unit, m.stock_qty AS stock_after, m.avg_cost_per_unit, m.aliases,
       (SELECT count(*) FROM erp_purchase_receipts r WHERE r.material_id = m.id) AS receipt_lines,
       (SELECT count(*) FROM erp_transactions t WHERE t.material_id = m.id) AS sale_lines
FROM erp_materials m
WHERE m.id IN (SELECT keep_id FROM material_merge_map_20261104);

-- Expect 0: nothing still points at a deleted duplicate.
SELECT count(*) AS orphan_lines FROM (
  SELECT material_id FROM erp_purchase_receipts
  UNION ALL SELECT material_id FROM erp_transactions
) x WHERE material_id IN (SELECT dup_id FROM material_merge_map_20261104);


-- ── ROLLBACK (only if something looks wrong) ────────────────────────────────
-- BEGIN;
-- INSERT INTO erp_materials SELECT b.*, '{}'::text[]
--   FROM erp_materials_backup_20261104 b
--   WHERE b.id IN (SELECT dup_id FROM material_merge_map_20261104);
-- UPDATE erp_materials k SET name = b.name, unit = b.unit, stock_qty = b.stock_qty,
--        avg_cost_per_unit = b.avg_cost_per_unit, aliases = '{}'
--   FROM erp_materials_backup_20261104 b
--   WHERE k.id = b.id AND k.id IN (SELECT keep_id FROM material_merge_map_20261104);
-- UPDATE erp_purchase_receipts t SET material_id = r.old_material_id
--   FROM material_merge_refs_backup_20261104 r
--   WHERE r.table_name = 'erp_purchase_receipts' AND t.id::text = r.row_id;
-- UPDATE erp_transactions t SET material_id = r.old_material_id
--   FROM material_merge_refs_backup_20261104 r
--   WHERE r.table_name = 'erp_transactions' AND t.id::text = r.row_id;
-- UPDATE erp_price_history t SET material_id = r.old_material_id
--   FROM material_merge_refs_backup_20261104 r
--   WHERE r.table_name = 'erp_price_history' AND t.id::text = r.row_id;
-- COMMIT;
-- (Units changed from KGS to kg are not reverted; that has no effect on totals.)


-- ── CLEANUP (after a week or two, once you are happy) ───────────────────────
-- DROP TABLE material_merge_map_20261104;
-- DROP TABLE erp_materials_backup_20261104;
-- DROP TABLE material_merge_refs_backup_20261104;
