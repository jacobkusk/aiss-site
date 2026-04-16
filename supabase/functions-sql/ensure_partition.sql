CREATE OR REPLACE FUNCTION public.ensure_partition(p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_partition_name TEXT;
  v_start DOUBLE PRECISION;
  v_end DOUBLE PRECISION;
BEGIN
  v_partition_name := 'positions_v2_' || to_char(p_date, 'YYYYMMDD');
  v_start := extract(epoch from p_date);
  v_end := extract(epoch from p_date + 1);
  
  -- Check if partition already exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = v_partition_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF positions_v2 FOR VALUES FROM (%s) TO (%s)',
      v_partition_name, v_start, v_end
    );
    -- Partitions don't inherit RLS policies — add public read
    EXECUTE format(
      'CREATE POLICY positions_v2_public_read ON %I FOR SELECT TO public USING (true)',
      v_partition_name
    );
  END IF;
END;
$function$
;
