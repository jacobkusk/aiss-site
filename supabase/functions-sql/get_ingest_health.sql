CREATE OR REPLACE FUNCTION public.get_ingest_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE result jsonb;
BEGIN
  WITH
  last_batch AS (
    SELECT ts, accepted, rejected
    FROM ingest_stats
    ORDER BY ts DESC
    LIMIT 1
  ),
  pos_5min AS (
    SELECT COUNT(*) AS n
    FROM positions_v2
    WHERE t >= extract(epoch from now() - interval '5 minutes')
  ),
  pos_hour AS (
    SELECT COUNT(*) AS n
    FROM positions_v2
    WHERE t >= extract(epoch from now() - interval '1 hour')
  ),
  active AS (
    SELECT COUNT(*) AS n
    FROM entity_last
    WHERE updated_at > now() - interval '30 minutes'
  )
  SELECT jsonb_build_object(
    'last_ingest',          (SELECT jsonb_build_object('ts', ts, 'accepted', accepted, 'rejected', rejected) FROM last_batch),
    'positions_last_5min',  (SELECT n FROM pos_5min),
    'positions_last_hour',  (SELECT n FROM pos_hour),
    'active_vessels_30min', (SELECT n FROM active)
  ) INTO result;
  RETURN result;
END;
$function$
;
