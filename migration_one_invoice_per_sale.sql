-- =============================================================================
-- Migration: One invoice per sale (instead of one invoice per material line)
-- =============================================================================
-- Before: every scale-ticket line (TXN-00045/1, /2 ...) had its own invoice row
--         (INV-00045/1, /2 ...) linked via erp_invoices.transaction_id.
-- After:  one invoice per sale (INV-00045). Each ticket line points to it via
--         erp_transactions.invoice_id. erp_invoices.transaction_id is dropped.
--
-- Run in the Supabase SQL editor. Run the PRE-CHECK first and review it, then
-- run the MIGRATION block. Deploy the new backend right after the migration:
-- the old backend can still list tickets, but cannot create/edit them once
-- erp_invoices.transaction_id is gone.

-- =============================================================================
-- PRE-CHECK (read-only) — review before migrating
-- =============================================================================
-- (a) Row counts
-- SELECT (SELECT count(*) FROM erp_transactions) AS ticket_lines,
--        (SELECT count(*) FROM erp_invoices)     AS invoice_lines,
--        (SELECT count(DISTINCT split_part(txn_number, '/', 1)) FROM erp_transactions) AS sales;
--
-- (b) Sales whose lines have different invoice statuses (status is merged:
--     all paid -> paid, else overdue > pending)
-- SELECT split_part(t.txn_number, '/', 1) AS sale, array_agg(DISTINCT i.status) AS statuses
-- FROM erp_transactions t JOIN erp_invoices i ON i.transaction_id = t.id
-- GROUP BY 1 HAVING count(DISTINCT i.status) > 1;
--
-- (c) Ticket lines with no invoice, and invoices with no ticket line
-- SELECT txn_number FROM erp_transactions t
-- WHERE NOT EXISTS (SELECT 1 FROM erp_invoices i WHERE i.transaction_id = t.id);
-- SELECT invoice_number FROM erp_invoices WHERE transaction_id IS NULL;

-- =============================================================================
-- MIGRATION
-- =============================================================================
BEGIN;

-- 0. Backups (drop these tables once you're happy with the result)
CREATE TABLE erp_invoices_backup_20261102     AS SELECT * FROM erp_invoices;
CREATE TABLE erp_transactions_backup_20261102 AS SELECT * FROM erp_transactions;

-- 1. New link: ticket line -> invoice of its sale
ALTER TABLE erp_transactions
  ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES erp_invoices(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_erp_transactions_invoice ON erp_transactions(invoice_id);

-- 2. Pick one invoice per sale (the lowest-numbered line's) and the merged status
CREATE TEMP TABLE sale_keeper ON COMMIT DROP AS
SELECT split_part(t.txn_number, '/', 1) AS sale,
       (array_agg(i.id ORDER BY i.invoice_number))[1] AS keeper_id,
       CASE
         WHEN bool_and(i.status = 'paid')      THEN 'paid'
         WHEN bool_or(i.status = 'overdue')    THEN 'overdue'
         WHEN bool_and(i.status = 'cancelled') THEN 'cancelled'
         ELSE 'pending'
       END AS merged_status
FROM erp_transactions t
JOIN erp_invoices i ON i.transaction_id = t.id
GROUP BY 1;

UPDATE erp_transactions t
SET invoice_id = k.keeper_id
FROM sale_keeper k
WHERE split_part(t.txn_number, '/', 1) = k.sale;

-- 3. Remove the other per-line invoices of each sale
DELETE FROM erp_invoices i
WHERE i.transaction_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM erp_transactions t WHERE t.invoice_id = i.id);

-- 4. Kept invoice: total of the whole sale + merged status
UPDATE erp_invoices i
SET amount     = s.total,
    status     = k.merged_status,
    paid_at    = CASE WHEN k.merged_status = 'paid' THEN i.paid_at END,
    updated_at = NOW()
FROM sale_keeper k
JOIN (SELECT invoice_id, SUM(total_amount) AS total FROM erp_transactions GROUP BY invoice_id) s
  ON s.invoice_id = k.keeper_id
WHERE i.id = k.keeper_id;

-- 5. INV-00045/1 -> INV-00045 (skipped if that number is somehow already taken)
UPDATE erp_invoices i
SET invoice_number = split_part(i.invoice_number, '/', 1)
WHERE i.invoice_number LIKE '%/%'
  AND NOT EXISTS (
    SELECT 1 FROM erp_invoices o
    WHERE o.invoice_number = split_part(i.invoice_number, '/', 1) AND o.id <> i.id
  );

-- 6. Sales that never had an invoice get one (pending, numbered after the ticket)
INSERT INTO erp_invoices (invoice_number, supplier_id, amount, status, created_at)
SELECT 'INV-' || split_part(split_part(t.txn_number, '/', 1), '-', 2),
       (array_agg(t.supplier_id))[1],
       SUM(t.total_amount),
       'pending',
       MIN(t.created_at)
FROM erp_transactions t
WHERE t.invoice_id IS NULL
GROUP BY split_part(t.txn_number, '/', 1)
ON CONFLICT (invoice_number) DO NOTHING;

UPDATE erp_transactions t
SET invoice_id = i.id
FROM erp_invoices i
WHERE t.invoice_id IS NULL
  AND i.invoice_number = 'INV-' || split_part(split_part(t.txn_number, '/', 1), '-', 2);

-- 7. Old per-line link is no longer used (also drops its FK and index)
ALTER TABLE erp_invoices DROP COLUMN transaction_id;

COMMIT;

-- =============================================================================
-- POST-CHECK
-- =============================================================================
-- Every sale has exactly one invoice and amounts match (expect 0 rows):
-- SELECT split_part(t.txn_number, '/', 1) AS sale, count(DISTINCT t.invoice_id) AS invoices,
--        SUM(t.total_amount) AS lines_total, MAX(i.amount) AS invoice_amount
-- FROM erp_transactions t LEFT JOIN erp_invoices i ON i.id = t.invoice_id
-- GROUP BY 1
-- HAVING count(DISTINCT t.invoice_id) <> 1 OR abs(SUM(t.total_amount) - MAX(i.amount)) > 0.01;
--
-- Tell PostgREST about the new relationship if embeds error with "could not find a relationship":
-- NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- ROLLBACK (only if needed, BEFORE any new tickets are created)
-- =============================================================================
-- BEGIN;
-- ALTER TABLE erp_transactions DROP COLUMN invoice_id;
-- DELETE FROM erp_invoices;
-- ALTER TABLE erp_invoices ADD COLUMN transaction_id UUID REFERENCES erp_transactions(id) ON DELETE CASCADE;
-- INSERT INTO erp_invoices (id, invoice_number, transaction_id, supplier_id, amount, status,
--                           due_date, paid_at, payment_method, notes, created_at, updated_at)
-- SELECT id, invoice_number, transaction_id, supplier_id, amount, status,
--        due_date, paid_at, payment_method, notes, created_at, updated_at
-- FROM erp_invoices_backup_20261102;
-- COMMIT;
