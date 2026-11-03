-- =============================================================================
-- Customer society + lead source (2026-11-04)
-- Run each STEP on its own in a NEW Supabase SQL tab, BEFORE the code deploy.
-- The society list matches KNOWN_SOCIETIES in src/lib/society.ts.
-- Matching ignores case, spaces and punctuation; the longest name wins.
-- =============================================================================


-- ── STEP 1: ADD COLUMNS (safe to run again) ─────────────────────────────────
ALTER TABLE erp_customers ADD COLUMN IF NOT EXISTS society     VARCHAR(120);
ALTER TABLE erp_customers ADD COLUMN IF NOT EXISTS lead_source VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_erp_customers_society ON erp_customers(society);
NOTIFY pgrst, 'reload schema';


-- ── STEP 2: PREVIEW (read-only) ─────────────────────────────────────────────
-- One row per active customer: the society that will be filled in.
-- "(no match)" rows keep a blank society; set those on the Customers page.
WITH societies(name) AS (VALUES
  ('Gaur City 1'), ('Gaur City 2'), ('Mahagun Mywoods'), ('Panchsheel Greens 2'),
  ('Supertech Eco Village 1'), ('Nirala Estate'), ('Fusion Homes'), ('Spring Homes'),
  ('ATS Happy Trails'), ('Ace Divino'), ('CRC Joyous'), ('Gulshan Bellina'), ('Ace City'),
  ('Ajnara Le Garden'), ('Ajnara Homes'), ('Panchsheel Hynish'), ('Renox Thrive'),
  ('Lotus Panache'), ('Parx Laureate'), ('Galaxy Vega'), ('Oxford Square'),
  ('Cherry County'), ('Unitech Horizon'), ('Divine Meadows')
), matched AS (
  SELECT DISTINCT ON (c.id) c.id, s.name AS society
  FROM erp_customers c
  JOIN societies s
    ON regexp_replace(lower(coalesce(c.address, '')), '[^a-z0-9]', '', 'g')
       LIKE '%' || regexp_replace(lower(s.name), '[^a-z0-9]', '', 'g') || '%'
  ORDER BY c.id, length(regexp_replace(s.name, '[^a-zA-Z0-9]', '', 'g')) DESC
)
SELECT coalesce(m.society, '(no match)') AS society, c.name, c.phone, c.address
FROM erp_customers c LEFT JOIN matched m ON m.id = c.id
WHERE c.is_active = true
ORDER BY (m.society IS NULL), m.society, c.name;


-- ── STEP 3: FILL BLANK SOCIETIES ────────────────────────────────────────────
-- Only customers whose society is still blank are touched, so it is safe to re-run.
-- Undo: UPDATE erp_customers SET society = NULL;  (nothing else uses it yet)
WITH societies(name) AS (VALUES
  ('Gaur City 1'), ('Gaur City 2'), ('Mahagun Mywoods'), ('Panchsheel Greens 2'),
  ('Supertech Eco Village 1'), ('Nirala Estate'), ('Fusion Homes'), ('Spring Homes'),
  ('ATS Happy Trails'), ('Ace Divino'), ('CRC Joyous'), ('Gulshan Bellina'), ('Ace City'),
  ('Ajnara Le Garden'), ('Ajnara Homes'), ('Panchsheel Hynish'), ('Renox Thrive'),
  ('Lotus Panache'), ('Parx Laureate'), ('Galaxy Vega'), ('Oxford Square'),
  ('Cherry County'), ('Unitech Horizon'), ('Divine Meadows')
), matched AS (
  SELECT DISTINCT ON (c.id) c.id, s.name AS society
  FROM erp_customers c
  JOIN societies s
    ON regexp_replace(lower(coalesce(c.address, '')), '[^a-z0-9]', '', 'g')
       LIKE '%' || regexp_replace(lower(s.name), '[^a-z0-9]', '', 'g') || '%'
  ORDER BY c.id, length(regexp_replace(s.name, '[^a-zA-Z0-9]', '', 'g')) DESC
)
UPDATE erp_customers c SET society = m.society, updated_at = NOW()
FROM matched m
WHERE m.id = c.id AND (c.society IS NULL OR c.society = '');

-- Check: customers per society
SELECT coalesce(society, '(blank)') AS society, count(*) AS customers
FROM erp_customers WHERE is_active = true
GROUP BY 1 ORDER BY 2 DESC;
