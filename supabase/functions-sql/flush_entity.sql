CREATE OR REPLACE FUNCTION public.flush_entity(p_entity_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_points      JSONB;
  v_pt_count    INT;
  v_prev_hash   TEXT;
  v_hash        TEXT;
  v_first_t     TIMESTAMPTZ;
  v_last_t      TIMESTAMPTZ;
  v_track_date  DATE;
  v_new_seg     GEOMETRY;
  v_last_str_t  TIMESTAMPTZ;
  v_gap_sec     FLOAT;
  v_new_segment BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_entity_id::text));

  SELECT points INTO v_points FROM entity_buffer WHERE entity_id = p_entity_id;
  IF v_points IS NULL THEN RETURN; END IF;

  v_pt_count := jsonb_array_length(v_points);
  IF v_pt_count = 0 THEN RETURN; END IF;

  v_first_t    := to_timestamp((v_points->0->>'t')::float);
  v_last_t     := to_timestamp((v_points->(v_pt_count-1)->>'t')::float);
  v_track_date := (v_last_t AT TIME ZONE 'UTC')::date;

  SELECT hash INTO v_prev_hash FROM evidence
  WHERE entity_id = p_entity_id ORDER BY flushed_at DESC LIMIT 1;
  v_prev_hash := COALESCE(v_prev_hash, '');
  v_hash := encode(digest(v_points::text || v_prev_hash, 'sha256'), 'hex');

  INSERT INTO evidence (entity_id, pts, hash, prev_hash, flushed_at, expires_at)
  VALUES (p_entity_id, v_points, v_hash, v_prev_hash, now(), now() + INTERVAL '90 days');

  -- Build new segment as LineStringM from buffered points
  SELECT ST_SetSRID(ST_MakeLine(array_agg(
    ST_MakePointM((pt->>'lon')::float, (pt->>'lat')::float, (pt->>'t')::float)
    ORDER BY (pt->>'t')::float
  )), 4326)
  INTO v_new_seg
  FROM jsonb_array_elements(v_points) pt;

  IF v_new_seg IS NULL OR ST_NPoints(v_new_seg) < 2 THEN
    UPDATE entity_buffer SET points = '[]', last_flushed_at = now()
    WHERE entity_id = p_entity_id;
    RETURN;
  END IF;

  SELECT last_t INTO v_last_str_t
  FROM strings WHERE entity_id = p_entity_id AND track_date = v_track_date;

  v_gap_sec     := COALESCE(EXTRACT(EPOCH FROM (v_first_t - v_last_str_t)), 0);
  v_new_segment := v_gap_sec > 240; -- 4 minutes = signal lost

  INSERT INTO strings (entity_id, track_date, geom, segment_count, point_count, first_t, last_t, updated_at)
  VALUES (
    p_entity_id, v_track_date,
    ST_Multi(v_new_seg)::geometry(MultiLineStringM, 4326),
    1, v_pt_count, v_first_t, v_last_t, now()
  )
  ON CONFLICT (entity_id, track_date) DO UPDATE SET
    geom = CASE
      WHEN v_new_segment THEN
        -- New gap: append v_new_seg as a new sub-geometry
        -- Decompose existing MultiLineString + add new LineString → collect back to Multi
        (SELECT ST_Multi(ST_Collect(array_agg(seg)))
         FROM (
           SELECT ST_GeometryN(strings.geom, i) AS seg
           FROM generate_series(1, ST_NumGeometries(strings.geom)) i
           UNION ALL
           SELECT v_new_seg
         ) x)::geometry(MultiLineStringM, 4326)

      WHEN ST_NumGeometries(strings.geom) = 1 THEN
        -- Single existing segment: merge with new points (extend the line)
        ST_Multi(
          ST_MakeLine(ARRAY[ST_GeometryN(strings.geom, 1), v_new_seg])
        )::geometry(MultiLineStringM, 4326)

      ELSE
        -- Multiple segments: extend the last one, keep the rest intact
        (SELECT ST_Multi(ST_Collect(array_agg(seg)))
         FROM (
           SELECT ST_GeometryN(strings.geom, i) AS seg
           FROM generate_series(1, ST_NumGeometries(strings.geom) - 1) i
           UNION ALL
           SELECT ST_MakeLine(ARRAY[
             ST_GeometryN(strings.geom, ST_NumGeometries(strings.geom)),
             v_new_seg
           ])
         ) x)::geometry(MultiLineStringM, 4326)
    END,
    segment_count = strings.segment_count + CASE WHEN v_new_segment THEN 1 ELSE 0 END,
    point_count   = strings.point_count + v_pt_count,
    last_t        = v_last_t,
    updated_at    = now();

  UPDATE entity_buffer SET points = '[]', last_flushed_at = now()
  WHERE entity_id = p_entity_id;
END;
$function$
;
