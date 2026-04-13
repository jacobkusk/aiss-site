CREATE OR REPLACE FUNCTION public.append_ais_line(p_mmsi bigint, p_pts jsonb, p_hash text, p_prev_hash text)
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

  -- Build LineStringM from new points (M = unix timestamp)
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

  -- Append to ais_line (or create if new vessel)
  INSERT INTO ais_line (mmsi, geom, first_t, last_t, point_count, updated_at)
  VALUES (p_mmsi, new_seg, first_ts, last_ts, pt_count, now())
  ON CONFLICT (mmsi) DO UPDATE SET
    geom = CASE
      WHEN ais_line.geom IS NULL THEN new_seg
      ELSE ST_SetSRID(ST_MakeLine(ARRAY[ais_line.geom, new_seg]), 4326)
    END,
    first_t = COALESCE(ais_line.first_t, first_ts),
    last_t  = last_ts,
    point_count = ais_line.point_count + pt_count,
    updated_at  = now();

  -- Append-only audit event
  INSERT INTO ais_line_events (mmsi, pts, hash, prev_hash)
  VALUES (p_mmsi, p_pts, p_hash, p_prev_hash);
END;
$function$
;
