-- =============================================================================
-- Migration: Operational Expense Categories & Improvements (Phase 2 / Categories)
-- =============================================================================

-- 1. Insert new categories into erp_expense_categories lookup table
INSERT INTO erp_expense_categories (name, is_active) VALUES
  ('Marketing – Offline', true),
  ('Marketing – Online', true),
  ('Internet & Telecommunication', true),
  ('Miscellaneous', true)
ON CONFLICT (name) DO NOTHING;

-- 2. Mark legacy 'Marketing' category as inactive
-- (Hidden from "Add Expense" dropdown, but preserved so historical rows render)
UPDATE erp_expense_categories
SET is_active = false
WHERE name = 'Marketing';

-- =============================================================================
-- DATA MIGRATION SCRIPT (DO NOT RUN AUTOMATICALLY - REVIEW AFFECTED ROWS FIRST)
-- =============================================================================
-- Decisions to confirm before executing data migration:
-- D1: Vodafone Idea recharges (EXP-1007, EXP-1008, EXP-1009) currently in 'Subscription'
--     migrate to 'Internet & Telecommunication'.
-- D2: Flyer/newspaper distribution rows (EXP-1010, EXP-1011, EXP-1012) currently in 'Marketing'
--     migrate to 'Marketing – Offline'.
-- D3: Legacy 'Marketing' remains inactive for future entries.

-- (a) Review affected Marketing rows before updating:
-- SELECT id, expense_number, expense_date, amount, vendor, description
-- FROM erp_expenses
-- WHERE category_id = (SELECT id FROM erp_expense_categories WHERE name = 'Marketing');
--
-- Expected: 3 rows (EXP-1010, EXP-1011, EXP-1012 - Newspaper flyers / distribution)

-- (b) Review affected Vodafone rows before updating:
-- SELECT id, expense_number, expense_date, amount, vendor, description
-- FROM erp_expenses
-- WHERE category_id = (SELECT id FROM erp_expense_categories WHERE name = 'Subscription')
--   AND vendor ILIKE '%vodafone%';
--
-- Expected: 3 rows (EXP-1007, EXP-1008, EXP-1009 - Vodafone Idea mobile recharge)

-- Migration statements to run ONLY once approved:
-- -----------------------------------------------------------------------------
-- UPDATE erp_expenses
-- SET category_id = (SELECT id FROM erp_expense_categories WHERE name = 'Marketing – Offline')
-- WHERE category_id = (SELECT id FROM erp_expense_categories WHERE name = 'Marketing');

-- UPDATE erp_expenses
-- SET category_id = (SELECT id FROM erp_expense_categories WHERE name = 'Internet & Telecommunication')
-- WHERE category_id = (SELECT id FROM erp_expense_categories WHERE name = 'Subscription')
--   AND vendor ILIKE '%vodafone%';
