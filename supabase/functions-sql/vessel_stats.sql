CREATE OR REPLACE FUNCTION public.vessel_stats()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH latest AS (
    SELECT DISTINCT ON (mmsi) mmsi, t
    FROM positions
    WHERE mmsi NOT IN (219123456, 219999999)
    ORDER BY mmsi, t DESC
  )
  SELECT jsonb_build_object(
    'hot',    COUNT(*) FILTER (WHERE t > extract(epoch from now() - interval '5 minutes')),
    'live',   COUNT(*) FILTER (WHERE t > extract(epoch from now() - interval '30 minutes')),
    'recent', COUNT(*) FILTER (WHERE t > extract(epoch from now() - interval '2 hours')),
    'total',  COUNT(*)
  )
  FROM latest;
$function$
;
