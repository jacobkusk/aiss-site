CREATE OR REPLACE FUNCTION public.get_live_vessels_geojson()
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
          'type', 'Point',
          'coordinates', jsonb_build_array(vl.lon, vl.lat)
        ),
        'properties', jsonb_build_object(
          'mmsi', vl.mmsi,
          'name', vl.name,
          'ship_type', vl.ship_type,
          'speed', vl.speed,
          'heading', vl.heading,
          'course', vl.course,
          'nav_status', vl.nav_status,
          'destination', vl.destination,
          'source', vl.source,
          'updated_at', vl.updated_at
        )
      )
    ), '[]'::jsonb)
  )
  FROM vessels_live vl
  WHERE vl.updated_at > now() - interval '15 minutes'
    AND vl.lat IS NOT NULL;
$function$
;
