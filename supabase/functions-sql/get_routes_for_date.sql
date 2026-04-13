CREATE OR REPLACE FUNCTION public.get_routes_for_date(p_date date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'mmsi', sub.mmsi,
      'ship_name', sub.name,
      'geojson', sub.linestring
    )
  ), '[]'::jsonb)
  FROM (
    SELECT
      p.mmsi,
      v.name,
      jsonb_build_object(
        'type', 'LineString',
        'coordinates', jsonb_agg(
          jsonb_build_array(ST_X(p.position::geometry), ST_Y(p.position::geometry))
          ORDER BY p.timestamp
        )
      ) AS linestring
    FROM ais_positions p
    LEFT JOIN vessels v ON v.mmsi = p.mmsi
    WHERE p.timestamp::date = p_date
    GROUP BY p.mmsi, v.name
    HAVING count(*) >= 3
  ) sub;
$function$
;
