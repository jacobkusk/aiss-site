-- Returns a FeatureCollection of vessel positions nearest to p_time within a
-- +/- p_window_minutes window. Called from TimeSlider.tsx when scrubbing.
--
-- Reads directly from positions_v2 (the source of truth). The previous
-- implementation also joined entity_buffer + evidence, but entity_buffer
-- was removed when ingest moved to ingest_positions_v2, which writes
-- positions_v2 + entity_last directly. That broke this RPC entirely.

CREATE OR REPLACE FUNCTION public.get_vessels_at_time(p_time timestamp with time zone, p_window_minutes integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p_epoch   float := extract(epoch from p_time);
  p_window  float := p_window_minutes * 60.0;
  result    jsonb;
BEGIN
  WITH
  candidates AS (
    SELECT
      p.entity_id,
      p.lon,
      p.lat,
      p.t,
      (p.sensors->>'sog_kn')::float AS sog,
      (p.sensors->>'cog')::float    AS cog,
      (p.sensors->>'hdg')::float    AS hdg,
      abs(p.t - p_epoch)            AS dt
    FROM positions_v2 p
    WHERE p.t BETWEEN (p_epoch - p_window) AND (p_epoch + p_window)
  ),
  closest AS (
    SELECT DISTINCT ON (c.entity_id)
      c.entity_id, c.lon, c.lat, c.t, c.sog, c.cog, c.hdg, c.dt
    FROM candidates c
    ORDER BY c.entity_id, c.dt
  ),
  named AS (
    SELECT
      (e.domain_meta->>'mmsi')::bigint AS mmsi,
      e.display_name                   AS name,
      c.lon, c.lat, c.t, c.sog, c.cog, c.hdg, c.dt
    FROM closest c
    JOIN entities e ON e.entity_id = c.entity_id
    WHERE e.entity_type = 'vessel'
      AND e.domain_meta ? 'mmsi'
  )
  SELECT jsonb_build_object(
    'type', 'FeatureCollection',
    'features', COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'type', 'Feature',
          'geometry', jsonb_build_object(
            'type', 'Point',
            'coordinates', jsonb_build_array(lon, lat)
          ),
          'properties', jsonb_build_object(
            'mmsi',           mmsi,
            'name',           name,
            'sog',            sog,
            'cog',            cog,
            'heading',        hdg,
            'recorded_at',    to_timestamp(t),
            'time_delta_sec', round(dt::numeric, 0)
          )
        )
      ),
      '[]'::jsonb
    )
  )
  INTO result
  FROM named;

  RETURN result;
END;
$function$
;
