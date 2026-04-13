CREATE OR REPLACE FUNCTION public.batch_upsert_static(p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  r jsonb;
  ok int := 0;
  v_mmsi bigint;
  v_name text;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_mmsi := (r->>'mmsi')::bigint;
    IF v_mmsi < 100000000 OR v_mmsi > 999999999 THEN CONTINUE; END IF;

    v_name := NULLIF(r->>'ship_name', '');

    -- Upsert into vessel_names (primary name store)
    IF v_name IS NOT NULL THEN
      INSERT INTO vessel_names (mmsi, name, updated_at)
      VALUES (v_mmsi, v_name, now())
      ON CONFLICT (mmsi) DO UPDATE SET name = EXCLUDED.name, updated_at = now();
    END IF;

    -- Keep vessels_live in sync if it exists
    UPDATE vessels_live SET
      name        = COALESCE(v_name, name),
      ship_type   = COALESCE((r->>'ship_type')::int, ship_type),
      destination = COALESCE(NULLIF(r->>'destination', ''), destination)
    WHERE mmsi = v_mmsi;

    ok := ok + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', ok);
END;
$function$
;
