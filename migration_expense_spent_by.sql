-- =============================================================================
-- Migration: "Spent by" on operational expenses
-- =============================================================================
-- Name of the person who made the expense (e.g. "Rahul", "Driver - Ramesh").
-- Run in the Supabase SQL editor BEFORE deploying the backend that reads it.

ALTER TABLE erp_expenses ADD COLUMN IF NOT EXISTS spent_by VARCHAR(100);

NOTIFY pgrst, 'reload schema';
