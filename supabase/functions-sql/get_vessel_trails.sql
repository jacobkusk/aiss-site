CREATE OR REPLACE FUNCTION public.get_vessel_trails()
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
          'coordinates', (
            SELECT jsonb_agg(jsonb_build_array((pt->>'lon')::float, (pt->>'lat')::float) ORDER BY (pt->>'t')::bigint)
            FROM jsonb_array_elements(at2.pts) pt
          )
        ),
        'properties', jsonb_build_object('mmsi', at2.mmsi)
      )
    ), '[]'::jsonb)
  )
  FROM ais_tail at2
  INNER JOIN ais_last al ON al.mmsi = at2.mmsi
  WHERE al.updated_at > now() - interval '10 minutes'
    AND al.speed > 0.5
    AND jsonb_array_length(at2.pts) >= 2;
$function$
;
