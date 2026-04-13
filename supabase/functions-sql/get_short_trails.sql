CREATE OR REPLACE FUNCTION public.get_short_trails()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT jsonb_build_object(
    'type', 'FeatureCollection',
    'features', COALESCE(jsonb_agg(
      jsonb_build_object(
        'type', 'Feature',
        'geometry', jsonb_build_object(
          'type', 'LineString',
          'coordinates', sub.coords
        ),
        'properties', jsonb_build_object('mmsi', sub.mmsi)
      )
    ), '[]'::jsonb)
  )
  FROM (
    SELECT
      mmsi,
      jsonb_agg(jsonb_build_array(
        round(ST_X(position::geometry)::numeric, 4),
        round(ST_Y(position::geometry)::numeric, 4)
      ) ORDER BY timestamp ASC) AS coords
    FROM (
      SELECT mmsi, position, timestamp,
        ROW_NUMBER() OVER (PARTITION BY mmsi ORDER BY timestamp DESC) AS rn
      FROM ais_positions
      WHERE timestamp > now() - interval '30 minutes'
        AND speed > 0.5
    ) ranked
    WHERE rn <= 6
    GROUP BY mmsi
    HAVING count(*) >= 2
  ) sub;
$function$
;
