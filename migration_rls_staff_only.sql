-- =============================================================================
-- Migration: limit direct Supabase reads to staff; lock expense tables;
--            make the Telegram receipt bucket private.
-- Safe to re-run. Apply in the Supabase SQL editor, then deploy the backend
-- (telegram.ts no longer creates the invoices bucket as public).
--
-- Why: signup is open, and every "…_authenticated_read" policy granted
-- SELECT to any logged-in session, so a self-registered user could read every
-- customer, booking and ERP row straight from PostgREST with the anon key.
-- The backend uses the service-role key (bypasses RLS) and is unaffected.
-- The policies stay (scoped to staff) because the ERP dashboard's Realtime
-- subscription on erp_transactions, erp_purchase_receipts and bookings only
-- delivers rows the subscriber can SELECT.
-- =============================================================================

-- 1. Helper: is the current session an admin or champion?
--    SECURITY DEFINER so it can read profiles regardless of profiles' own RLS.
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'champion')
  );
$$;

REVOKE ALL ON FUNCTION public.is_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated;

-- 2. Replace "any authenticated user" read policies with staff-only ones
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'erp_materials', 'erp_suppliers', 'erp_customers', 'erp_transactions',
    'erp_invoices', 'erp_purchase_receipts', 'erp_price_history',
    'erp_whatsapp_logs', 'erp_notifications', 'erp_sale_batches'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "erp_authenticated_read" ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS "erp_staff_read" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "erp_staff_read" ON %I FOR SELECT TO authenticated USING (public.is_staff())',
      t
    );
  END LOOP;
END $$;

-- Bookings: staff see all; a resident sees only their own
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bookings_authenticated_read" ON bookings;
DROP POLICY IF EXISTS "bookings_staff_or_owner_read" ON bookings;
CREATE POLICY "bookings_staff_or_owner_read" ON bookings
  FOR SELECT TO authenticated
  USING (public.is_staff() OR user_id = auth.uid());

ALTER TABLE telegram_ingested_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tgreceipts_authenticated_read" ON telegram_ingested_receipts;
DROP POLICY IF EXISTS "tgreceipts_staff_read" ON telegram_ingested_receipts;
CREATE POLICY "tgreceipts_staff_read" ON telegram_ingested_receipts
  FOR SELECT TO authenticated
  USING (public.is_staff());

-- 3. Expense tables: RLS on with no policies (backend-only access).
--    Already switched on by hand in the live dashboard; this records it.
ALTER TABLE erp_expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_expenses           ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION nextval_expense_number() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nextval_expense_number() TO service_role;

-- 4. Telegram receipt PDFs: private bucket (the API already returns signed URLs)
UPDATE storage.buckets SET public = false WHERE id = 'invoices';
