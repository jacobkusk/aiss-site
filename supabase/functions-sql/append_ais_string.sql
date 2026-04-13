CREATE OR REPLACE FUNCTION public.append_ais_string(p_mmsi bigint, p_pts jsonb, p_new_segment boolean, p_hash text, p_prev_hash text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  new_seg geometry;
  pt_count int;
  first_ts timestamptz;
  last_ts timestamptz;
BEGIN
  pt_count := jsonb_array_length(p_pts);
  IF pt_count = 0 THEN RETURN; END IF;

  SELECT ST_SetSRID(ST_MakeLine(array_agg(
    ST_MakePointM(
      (pt->>'lon')::float,
      (pt->>'lat')::float,
      (pt->>'t')::float
    ) ORDER BY (pt->>'t')::float
  )), 4326)
  INTO new_seg
  FROM jsonb_array_elements(p_pts) pt;

  first_ts := to_timestamp((p_pts->0->>'t')::float);
  last_ts  := to_timestamp((p_pts->(pt_count-1)->>'t')::float);

  INSERT INTO ais_string (mmsi, geom, first_t, last_t, segment_count, point_count, updated_at)
  VALUES (p_mmsi, ST_Multi(new_seg), first_ts, last_ts, 1, pt_count, now())
  ON CONFLICT (mmsi) DO UPDATE SET
    geom = CASE
      WHEN ais_string.geom IS NULL THEN ST_Multi(new_seg)
      WHEN p_new_segment THEN
        ST_Collect(ais_string.geom, new_seg)::geometry(MultiLineStringM, 4326)
      ELSE
        (SELECT ST_SetSRID(
          CASE WHEN ST_NumGeometries(ais_string.geom) = 1 THEN
            ST_Multi(ST_MakeLine(ARRAY[ST_GeometryN(ais_string.geom, 1), new_seg]))
          ELSE
            ST_Collect(
              (SELECT ST_Collect(array_agg(ST_GeometryN(ais_string.geom, i)))
               FROM generate_series(1, ST_NumGeometries(ais_string.geom) - 1) i),
              ST_MakeLine(ARRAY[
                ST_GeometryN(ais_string.geom, ST_NumGeometries(ais_string.geom)),
                new_seg
              ])
            )
          END, 4326)::geometry(MultiLineStringM, 4326))
      END,
    first_t       = COALESCE(ais_string.first_t, first_ts),
    last_t        = last_ts,
    segment_count = CASE WHEN p_new_segment THEN ais_string.segment_count + 1 ELSE ais_string.segment_count END,
    point_count   = ais_string.point_count + pt_count,
    updated_at    = now();

  INSERT INTO ais_line_events (mmsi, pts, hash, prev_hash)
  VALUES (p_mmsi, p_pts, p_hash, p_prev_hash);
END;
$function$
;
