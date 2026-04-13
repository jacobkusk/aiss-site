CREATE OR REPLACE FUNCTION public.get_tracks_in_range(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_result JSON;
  v_sql TEXT;
  v_parts TEXT[];
  v_part TEXT;
BEGIN
  -- Dynamically find partitions that exist for the requested date range
  SELECT array_agg(c.relname ORDER BY c.relname)
  INTO v_parts
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
  WHERE p.relname = 'positions_v2';

  IF v_parts IS NULL OR array_length(v_parts, 1) = 0 THEN
    RETURN json_build_object('points', '[]'::json);
  END IF;

  -- Build dynamic UNION ALL over all existing partitions
  v_sql := '';
  FOREACH v_part IN ARRAY v_parts LOOP
    IF v_sql != '' THEN v_sql := v_sql || ' UNION ALL '; END IF;
    v_sql := v_sql || format(
      'SELECT entity_id, lat, lon, t FROM %I WHERE t BETWEEN %s AND %s',
      v_part,
      extract(epoch from p_start),
      extract(epoch from p_end)
    );
  END LOOP;

  -- Main query: join positions with entities for names + mmsi
  v_sql := format('
    WITH pos AS (%s)
    SELECT json_build_object(
      ''points'', coalesce(
        json_agg(
          json_build_object(
            ''mmsi'', (e.domain_meta->>''mmsi'')::BIGINT,
            ''name'', COALESCE(e.display_name, e.domain_meta->>''vessel_name''),
            ''lat'', p.lat,
            ''lon'', p.lon,
            ''sog'', (el.sensors->>''sog_kn'')::DOUBLE PRECISION,
            ''cog'', (el.sensors->>''cog'')::DOUBLE PRECISION,
            ''t'', p.t::BIGINT
          ) ORDER BY p.t
        ) FILTER (WHERE p.lat IS NOT NULL AND p.lon IS NOT NULL AND e.domain_meta->>''mmsi'' IS NOT NULL),
        ''[]''::json
      )
    )
    FROM pos p
    LEFT JOIN entities e ON p.entity_id = e.entity_id
    LEFT JOIN entity_last el ON p.entity_id = el.entity_id
  ', v_sql);

  EXECUTE v_sql INTO v_result;
  RETURN v_result;
END;
$function$
;
