CREATE OR REPLACE FUNCTION public.run_rpc_health_checks()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_ok     boolean;
  v_detail text;
  v_count  int;
BEGIN
  -- ── 1. get_live_vessels ─────────────────────────────────────────
  BEGIN
    SELECT count(*) INTO v_count FROM get_live_vessels(1440);
    v_ok     := true;
    v_detail := v_count || ' vessels returned';
  EXCEPTION WHEN OTHERS THEN
    v_ok     := false;
    v_detail := SQLERRM;
  END;
  INSERT INTO rpc_health (rpc_name, ok, detail) VALUES ('get_live_vessels', v_ok, v_detail);

  -- ── 2. get_tracks_in_range ──────────────────────────────────────
  BEGIN
    PERFORM get_tracks_in_range(now() - interval '24 hours', now());
    v_ok     := true;
    v_detail := 'ok';
  EXCEPTION WHEN OTHERS THEN
    v_ok     := false;
    v_detail := SQLERRM;
  END;
  INSERT INTO rpc_health (rpc_name, ok, detail) VALUES ('get_tracks_in_range', v_ok, v_detail);

  -- ── 3. entity_last has rows (live map source) ───────────────────
  BEGIN
    SELECT count(*) INTO v_count FROM entity_last;
    v_ok     := v_count > 0;
    v_detail := v_count || ' rows';
  EXCEPTION WHEN OTHERS THEN
    v_ok     := false;
    v_detail := SQLERRM;
  END;
  INSERT INTO rpc_health (rpc_name, ok, detail) VALUES ('entity_last', v_ok, v_detail);

  -- ── 4. positions_v2 has data in last 48h ────────────────────────
  BEGIN
    SELECT count(*) INTO v_count
    FROM positions_v2
    WHERE t > extract(epoch from now() - interval '48 hours');
    v_ok     := v_count > 0;
    v_detail := v_count || ' positions in 48h';
  EXCEPTION WHEN OTHERS THEN
    v_ok     := false;
    v_detail := SQLERRM;
  END;
  INSERT INTO rpc_health (rpc_name, ok, detail) VALUES ('positions_v2', v_ok, v_detail);

  -- ── Prune: keep only last 500 rows per RPC ──────────────────────
  DELETE FROM rpc_health
  WHERE id IN (
    SELECT id FROM (
      SELECT id,
             row_number() OVER (PARTITION BY rpc_name ORDER BY checked_at DESC) AS rn
      FROM rpc_health
    ) ranked
    WHERE rn > 500
  );
END;
$function$
;
