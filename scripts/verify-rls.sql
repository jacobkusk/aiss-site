-- RLS Verification Script
-- Run this after every database migration or schema change
-- Any table in the results = broken for frontend (anon gets 0 rows)

-- 1. Tables with RLS enabled but NO read policy
SELECT '❌ NO POLICY' as status, c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relrowsecurity = true
  AND n.nspname = 'public'
  AND NOT EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.tablename = c.relname
    AND p.cmd = 'SELECT'
  )
ORDER BY c.relname;

-- 2. Tables with RLS enabled AND a read policy (healthy)
SELECT '✅ OK' as status, c.relname AS table_name, p.policyname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_policies p ON p.tablename = c.relname AND p.cmd = 'SELECT'
WHERE c.relrowsecurity = true
  AND n.nspname = 'public'
ORDER BY c.relname;

-- 3. Tables with RLS disabled (open to all — verify this is intentional)
SELECT '⚠️  RLS OFF' as status, c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND NOT c.relrowsecurity
  AND n.nspname = 'public'
ORDER BY c.relname;
