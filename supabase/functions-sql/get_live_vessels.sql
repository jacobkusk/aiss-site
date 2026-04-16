CREATE OR REPLACE FUNCTION public.get_live_vessels(p_minutes integer DEFAULT 30)
 RETURNS TABLE(entity_id uuid, display_name text, mmsi bigint, lat double precision, lon double precision, speed double precision, bearing double precision, t timestamp with time zone, source text, source_count integer, sensors jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT 
    el.entity_id,
    e.display_name,
    (e.domain_meta->>'mmsi')::BIGINT AS mmsi,
    el.lat,
    el.lon,
    el.speed,
    el.bearing,
    el.t,
    el.source,
    COALESCE(el.source_count, 1),
    el.sensors
  FROM entity_last el
  JOIN entities e ON e.entity_id = el.entity_id
  WHERE el.updated_at > now() - (p_minutes || ' minutes')::INTERVAL
  ORDER BY el.updated_at DESC;
$function$
;
