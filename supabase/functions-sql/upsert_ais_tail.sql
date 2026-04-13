CREATE OR REPLACE FUNCTION public.upsert_ais_tail(p_mmsi bigint, p_pts jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  INSERT INTO ais_tail (mmsi, pts, updated_at)
  VALUES (p_mmsi, p_pts, now())
  ON CONFLICT (mmsi) DO UPDATE SET
    pts = EXCLUDED.pts,
    updated_at = EXCLUDED.updated_at;
END;
$function$
;
