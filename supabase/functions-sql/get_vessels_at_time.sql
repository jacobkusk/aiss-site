CREATE OR REPLACE FUNCTION public.get_vessels_at_time(p_time timestamp with time zone, p_window_minutes integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  p_epoch   float := extract(epoch from p_time);
  p_window  float := p_window_minutes * 60.0;
  result    jsonb;
BEGIN
  WITH
  ev_points AS (
    SELECT
      (e.domain_meta->>'mmsi')::bigint  AS mmsi,
      e.display_name                    AS name,
      (pt->>'lon')::float               AS lon,
      (pt->>'lat')::float               AS lat,
      (pt->>'sog')::float               AS sog,
      (pt->>'cog')::float               AS cog,
      (pt->>'hdg')::float               AS hdg,
      (pt->>'t')::float                 AS t,
      abs((pt->>'t')::float - p_epoch)  AS dt
    FROM entities e
    JOIN evidence ev ON ev.entity_id = e.entity_id
    CROSS JOIN LATERAL jsonb_array_elements(ev.pts) AS pt
    WHERE e.entity_type = 'vessel'
      AND e.domain_meta ? 'mmsi'
      AND ev.flushed_at >= (p_time - make_interval(mins => p_window_minutes + 10))
      AND ev.flushed_at <= (p_time + make_interval(mins => p_window_minutes + 10))
      AND (pt->>'t')::float BETWEEN (p_epoch - p_window) AND (p_epoch + p_window)
  ),
  buf_points AS (
    SELECT
      (e.domain_meta->>'mmsi')::bigint  AS mmsi,
      e.display_name                    AS name,
      (pt->>'lon')::float               AS lon,
      (pt->>'lat')::float               AS lat,
      (pt->>'sog')::float               AS sog,
      (pt->>'cog')::float               AS cog,
      (pt->>'hdg')::float               AS hdg,
      (pt->>'t')::float                 AS t,
      abs((pt->>'t')::float - p_epoch)  AS dt
    FROM entities e
    JOIN entity_buffer eb ON eb.entity_id = e.entity_id
    CROSS JOIN LATERAL jsonb_array_elements(eb.points) AS pt
    WHERE e.entity_type = 'vessel'
      AND e.domain_meta ? 'mmsi'
      AND (pt->>'t')::float BETWEEN (p_epoch - p_window) AND (p_epoch + p_window)
  ),
  all_points AS (
    SELECT * FROM ev_points
    UNION ALL
    SELECT * FROM buf_points
  ),
  closest AS (
    SELECT DISTINCT ON (mmsi)
      mmsi, name, lon, lat, sog, cog, hdg, t, dt
    FROM all_points
    WHERE lon IS NOT NULL AND lat IS NOT NULL
    ORDER BY mmsi, dt
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
  FROM closest;

  RETURN result;
END;
$function$
;
