-- =============================================================================
-- The Scrap Co. ERP Integration Schema
-- Run this script in your Supabase SQL Editor to create all ERP-specific tables.
-- All tables are prefixed with "erp_" to prevent conflict with other tables.
-- =============================================================================

-- 1. ERP Materials Catalog
CREATE TABLE IF NOT EXISTS erp_materials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) UNIQUE NOT NULL,
  category      VARCHAR(50) NOT NULL,
  unit          VARCHAR(10) NOT NULL DEFAULT 'kg',
  buy_price     NUMERIC(12,2) NOT NULL DEFAULT 0,
  sell_price    NUMERIC(12,2) NOT NULL DEFAULT 0,
  stock_qty     NUMERIC(12,2) NOT NULL DEFAULT 0,
  min_threshold NUMERIC(12,2) NOT NULL DEFAULT 0,
  color_hex     VARCHAR(7) DEFAULT '#f5a623',
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 2. ERP Suppliers (B2B)
CREATE TABLE IF NOT EXISTS erp_suppliers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(150) NOT NULL,
  phone        VARCHAR(20),
  whatsapp     VARCHAR(20),
  upi          VARCHAR(20),
  email        VARCHAR(150),
  address      TEXT,
  id_type      VARCHAR(30),
  id_number    VARCHAR(50),
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 3. ERP Customers (B2C Household Customers)
CREATE TABLE IF NOT EXISTS erp_customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  phone         VARCHAR(20),
  address       TEXT,
  id_type       VARCHAR(50) DEFAULT 'Aadhaar',
  id_number     VARCHAR(100),
  total_visits  INT DEFAULT 0,
  total_paid    DECIMAL(12,2) DEFAULT 0,
  is_active     BOOLEAN DEFAULT true,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 4. ERP Transactions (B2B scale entries)
CREATE TABLE IF NOT EXISTS erp_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  txn_number      VARCHAR(20) UNIQUE NOT NULL,
  supplier_id     UUID REFERENCES erp_suppliers(id) ON DELETE SET NULL,
  material_id     UUID REFERENCES erp_materials(id) ON DELETE SET NULL,
  weight          NUMERIC(12,3) NOT NULL,
  unit            VARCHAR(10) NOT NULL DEFAULT 'kg',
  price_per_unit  NUMERIC(12,2) NOT NULL,
  subtotal        NUMERIC(14,2) NOT NULL,
  gst_rate        NUMERIC(5,2) DEFAULT 0,
  gst_amount      NUMERIC(12,2) DEFAULT 0,
  total_amount    NUMERIC(14,2) NOT NULL,
  notes           TEXT,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 5. ERP Invoices (B2B payments due)
CREATE TABLE IF NOT EXISTS erp_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number  VARCHAR(20) UNIQUE NOT NULL,
  transaction_id  UUID REFERENCES erp_transactions(id) ON DELETE CASCADE,
  supplier_id     UUID REFERENCES erp_suppliers(id) ON DELETE SET NULL,
  amount          NUMERIC(14,2) NOT NULL,
  status          VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','paid','overdue','cancelled')),
  due_date        DATE,
  paid_at         TIMESTAMPTZ,
  payment_method  VARCHAR(30),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 6. ERP Purchase Receipts (B2C household entries)
CREATE TABLE IF NOT EXISTS erp_purchase_receipts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number VARCHAR(50) UNIQUE NOT NULL,
  customer_id    UUID REFERENCES erp_customers(id) ON DELETE SET NULL,
  material_id    UUID REFERENCES erp_materials(id) ON DELETE SET NULL,
  weight         DECIMAL(10,3) NOT NULL,
  unit           VARCHAR(10) DEFAULT 'kg',
  price_per_unit DECIMAL(10,2) NOT NULL,
  total_amount   DECIMAL(12,2) NOT NULL,
  payment_method VARCHAR(50) DEFAULT 'cash',
  notes          TEXT,
  created_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 7. ERP Price History
CREATE TABLE IF NOT EXISTS erp_price_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id    UUID REFERENCES erp_materials(id) ON DELETE CASCADE,
  old_buy_price  NUMERIC(12,2),
  new_buy_price  NUMERIC(12,2),
  old_sell_price NUMERIC(12,2),
  new_sell_price NUMERIC(12,2),
  changed_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 8. ERP WhatsApp Logs
CREATE TABLE IF NOT EXISTS erp_whatsapp_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES erp_transactions(id) ON DELETE SET NULL,
  supplier_phone VARCHAR(20),
  status         VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent','failed','skipped')),
  message_id     VARCHAR(100),
  provider       VARCHAR(20) DEFAULT 'twilio',
  pdf_url        TEXT,
  error          TEXT,
  sent_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Sequence for B2C Receipt Numbers
CREATE SEQUENCE IF NOT EXISTS receipt_number_seq START 1001;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_erp_transactions_supplier  ON erp_transactions(supplier_id);
CREATE INDEX IF NOT EXISTS idx_erp_transactions_material  ON erp_transactions(material_id);
CREATE INDEX IF NOT EXISTS idx_erp_transactions_created   ON erp_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_erp_invoices_status        ON erp_invoices(status);
CREATE INDEX IF NOT EXISTS idx_erp_invoices_transaction   ON erp_invoices(transaction_id);
CREATE INDEX IF NOT EXISTS idx_erp_price_history_material ON erp_price_history(material_id);
CREATE INDEX IF NOT EXISTS idx_erp_purchase_receipts_cust ON erp_purchase_receipts(customer_id);
CREATE INDEX IF NOT EXISTS idx_erp_whatsapp_logs_txn      ON erp_whatsapp_logs(transaction_id);

-- Migration: Add additional contact fields (whatsapp and upi) to B2C Customers
ALTER TABLE erp_customers ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(20);
ALTER TABLE erp_customers ADD COLUMN IF NOT EXISTS upi VARCHAR(20);

-- Migration: Remove category CHECK constraint from erp_materials to support custom categories
ALTER TABLE erp_materials DROP CONSTRAINT IF EXISTS erp_materials_category_check;
ALTER TABLE erp_materials ALTER COLUMN category TYPE VARCHAR(50);

-- Migration: Add additional contact fields (whatsapp and upi) to B2B Suppliers
ALTER TABLE erp_suppliers ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(20);
ALTER TABLE erp_suppliers ADD COLUMN IF NOT EXISTS upi VARCHAR(20);

-- Migration: Add ERP Notifications Table
CREATE TABLE IF NOT EXISTS erp_notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       VARCHAR(255) NOT NULL,
  message     TEXT NOT NULL,
  type        VARCHAR(50) NOT NULL DEFAULT 'general',
  booking_id  UUID,
  is_read     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_erp_notifications_created ON erp_notifications(created_at DESC);

-- Migration: Add last_receipt_date to B2C Customers & customer_id to Notifications
ALTER TABLE erp_customers ADD COLUMN IF NOT EXISTS last_receipt_date TIMESTAMPTZ;
ALTER TABLE erp_notifications ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES erp_customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_erp_customers_last_receipt ON erp_customers(last_receipt_date);

-- Migration: Track weighted average buy cost per material (auto-updated by backend on every receipt)
ALTER TABLE erp_materials ADD COLUMN IF NOT EXISTS avg_cost_per_unit DECIMAL(10,2) DEFAULT 0;


-- =============================================================================
-- BOOKINGS TABLE
-- Household customer pickup appointment bookings (B2C inbound flow).
-- This table was created outside the migration — defined here for completeness
-- so the full schema lives in one place. Safe to run on existing databases.
-- =============================================================================

CREATE TABLE IF NOT EXISTS bookings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name               VARCHAR(255) NOT NULL,
  phone                   VARCHAR(20)  NOT NULL,
  society                 TEXT         NOT NULL,
  tower                   VARCHAR(120),
  pickup_date             DATE         NOT NULL,
  materials               TEXT[]       NOT NULL DEFAULT '{}',
  status                  VARCHAR(30)  NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','confirmed','completed','cancelled')),
  actual_weights          JSONB        DEFAULT '{}',
  champion_id             UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  user_id                 UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  -- CRM fields (added via migration below — kept here for reference)
  inquiry_date            DATE,
  last_communication_date DATE,
  status_comments         TEXT,
  source                  VARCHAR(20)  DEFAULT 'website'
                            CHECK (source IN ('website','whatsapp','phone','walkin')),
  pincode                 VARCHAR(10),
  created_at              TIMESTAMPTZ  DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_status     ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_pickup     ON bookings(pickup_date);
CREATE INDEX IF NOT EXISTS idx_bookings_champion   ON bookings(champion_id);
CREATE INDEX IF NOT EXISTS idx_bookings_user       ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_created    ON bookings(created_at DESC);

-- RLS
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bookings' AND policyname = 'bookings_authenticated_read') THEN
    CREATE POLICY "bookings_authenticated_read" ON bookings FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- Migration: Add CRM tracking fields to bookings — safe to re-run (IF NOT EXISTS)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS inquiry_date            DATE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_communication_date DATE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status_comments         TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS source                  VARCHAR(20) DEFAULT 'website';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pincode                 VARCHAR(10);
CREATE INDEX IF NOT EXISTS idx_bookings_source ON bookings(source);


-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- Applied to all ERP tables to block direct anon/public access.
-- The Express backend uses SUPABASE_SERVICE_KEY which bypasses RLS entirely,
-- so no backend queries are affected. The frontend anon key cannot read ERP
-- data directly — all ERP access must go through the authenticated API.
-- =============================================================================

-- Enable RLS on all ERP tables
ALTER TABLE erp_materials         ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_suppliers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_customers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_transactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_invoices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_purchase_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_price_history     ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_whatsapp_logs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_notifications     ENABLE ROW LEVEL SECURITY;

-- Allow authenticated Supabase users (logged-in frontend) to READ ERP data.
-- Writes are blocked for authenticated users too — only service_role (backend) can write.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'erp_materials' AND policyname = 'erp_authenticated_read') THEN
    CREATE POLICY "erp_authenticated_read" ON erp_materials FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'erp_suppliers' AND policyname = 'erp_authenticated_read') THEN
    CREATE POLICY "erp_authenticated_read" ON erp_suppliers FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'erp_customers' AND policyname = 'erp_authenticated_read') THEN
    CREATE POLICY "erp_authenticated_read" ON erp_customers FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'erp_transactions' AND policyname = 'erp_authenticated_read') THEN
    CREATE POLICY "erp_authenticated_read" ON erp_transactions FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'erp_invoices' AND policyname = 'erp_authenticated_read') THEN
    CREATE POLICY "erp_authenticated_read" ON erp_invoices FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'erp_purchase_receipts' AND policyname = 'erp_authenticated_read') THEN
    CREATE POLICY "erp_authenticated_read" ON erp_purchase_receipts FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'erp_price_history' AND policyname = 'erp_authenticated_read') THEN
    CREATE POLICY "erp_authenticated_read" ON erp_price_history FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'erp_whatsapp_logs' AND policyname = 'erp_authenticated_read') THEN
    CREATE POLICY "erp_authenticated_read" ON erp_whatsapp_logs FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'erp_notifications' AND policyname = 'erp_authenticated_read') THEN
    CREATE POLICY "erp_authenticated_read" ON erp_notifications FOR SELECT TO authenticated USING (true);
  END IF;
END $$;


-- NOTE: No INSERT/UPDATE/DELETE policies are created for authenticated users.
-- All writes go through the backend (service_role key bypasses RLS).
-- Anon (unauthenticated) users have zero access to any ERP table.



