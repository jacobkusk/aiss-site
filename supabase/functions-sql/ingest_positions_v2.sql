-- Write path for AIS positions. Called by the `ingest-positions` edge function
-- after edge-level normalisation + hard rejects. Does soft validation (MMSI
-- range, coord sanity, Null Island), classifies entity_type from MMSI prefix
-- (vessel / station / sar_aircraft / aton / beacon), upserts the entity,
-- appends to positions_v2, and upserts entity_last (live cache).
--
-- Per-reason rejection counters are MERGED with the edge counters and
-- persisted to ingest_stats.reject_reasons — a single ingest_stats row gives
-- the full story (edge + rpc) for diagnostic use per CLAUDE.md §3.

CREATE OR REPLACE FUNCTION public.ingest_positions_v2(
  p_rows jsonb,
  p_source_name text DEFAULT 'pi4_rtlsdr'::text,
  p_edge_rejected integer DEFAULT 0,
  p_edge_reasons jsonb DEFAULT '{}'::jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  r                JSONB;
  v_mmsi           BIGINT;
  v_mmsi_padded    TEXT;
  v_mmsi_prefix2   TEXT;
  v_mmsi_prefix3   TEXT;
  v_entity_type    TEXT;
  v_lat            DOUBLE PRECISION;
  v_lon            DOUBLE PRECISION;
  v_alt            DOUBLE PRECISION;
  v_t              DOUBLE PRECISION;
  v_sog            DOUBLE PRECISION;
  v_cog            DOUBLE PRECISION;
  v_hdg            DOUBLE PRECISION;
  v_name           TEXT;
  v_entity_id      UUID;
  v_source_id      UUID;
  v_sensors        JSONB;
  v_accepted       INT := 0;
  v_rpc_rejected   INT := 0;
  v_rpc_reasons    JSONB := jsonb_build_object(
                      'mmsi_invalid', 0,
                      'invalid_coords', 0,
                      'out_of_bounds', 0,
                      'null_island', 0,
                      'rpc_other', 0
                   );
  v_merged_reasons JSONB;
  v_start_ms       DOUBLE PRECISION;
BEGIN
  v_start_ms := extract(epoch from clock_timestamp()) * 1000;

  -- Resolve source
  SELECT source_id INTO v_source_id
  FROM ingest_sources WHERE name = p_source_name AND is_active = true;

  IF v_source_id IS NULL THEN
    RETURN jsonb_build_object('error', 'unknown or inactive source: ' || p_source_name);
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    -- Extract fields (handle multiple naming conventions)
    v_mmsi := COALESCE((r->>'mmsi')::BIGINT, (r->>'MMSI')::BIGINT);
    v_lat  := COALESCE((r->>'lat')::DOUBLE PRECISION, (r->>'latitude')::DOUBLE PRECISION);
    v_lon  := COALESCE((r->>'lon')::DOUBLE PRECISION, (r->>'longitude')::DOUBLE PRECISION, (r->>'lng')::DOUBLE PRECISION);
    v_alt  := COALESCE((r->>'alt')::DOUBLE PRECISION, (r->>'altitude')::DOUBLE PRECISION, 0);
    v_t    := COALESCE((r->>'t')::DOUBLE PRECISION, (r->>'timestamp')::DOUBLE PRECISION, extract(epoch from now()));
    v_sog  := COALESCE((r->>'sog')::DOUBLE PRECISION, (r->>'speed')::DOUBLE PRECISION, (r->>'SOG')::DOUBLE PRECISION);
    v_cog  := COALESCE((r->>'cog')::DOUBLE PRECISION, (r->>'course')::DOUBLE PRECISION, (r->>'COG')::DOUBLE PRECISION);
    v_hdg  := COALESCE((r->>'hdg')::DOUBLE PRECISION, (r->>'heading')::DOUBLE PRECISION, (r->>'HDG')::DOUBLE PRECISION);
    v_name := NULLIF(COALESCE(r->>'vessel_name', r->>'name', r->>'shipname'), '');

    -- === VALIDATION (soft — edge has already rejected hard failures) ===
    -- Widen MMSI range: accept anything 1..999_999_999 so base stations etc. survive.
    IF v_mmsi IS NULL OR v_mmsi < 1 OR v_mmsi > 999999999 THEN
      v_rpc_rejected := v_rpc_rejected + 1;
      v_rpc_reasons := jsonb_set(v_rpc_reasons, '{mmsi_invalid}',
        to_jsonb((v_rpc_reasons->>'mmsi_invalid')::INT + 1));
      CONTINUE;
    END IF;

    IF v_lat IS NULL OR v_lon IS NULL THEN
      v_rpc_rejected := v_rpc_rejected + 1;
      v_rpc_reasons := jsonb_set(v_rpc_reasons, '{invalid_coords}',
        to_jsonb((v_rpc_reasons->>'invalid_coords')::INT + 1));
      CONTINUE;
    END IF;
    IF v_lat < -90 OR v_lat > 90 OR v_lon < -180 OR v_lon > 180 THEN
      v_rpc_rejected := v_rpc_rejected + 1;
      v_rpc_reasons := jsonb_set(v_rpc_reasons, '{out_of_bounds}',
        to_jsonb((v_rpc_reasons->>'out_of_bounds')::INT + 1));
      CONTINUE;
    END IF;
    IF v_lat = 0 AND v_lon = 0 THEN
      v_rpc_rejected := v_rpc_rejected + 1;
      v_rpc_reasons := jsonb_set(v_rpc_reasons, '{null_island}',
        to_jsonb((v_rpc_reasons->>'null_island')::INT + 1));
      CONTINUE;
    END IF;

    -- === CLASSIFY ENTITY TYPE FROM MMSI PREFIX ===
    --   00MID…  -> coast station
    --   111MID… -> SAR aircraft
    --   99MID…  -> AtoN (Aid to Navigation)
    --   970MID… -> AIS-SART
    --   972MID… -> MOB
    --   974MID… -> EPIRB
    --   otherwise -> vessel
    v_mmsi_padded := lpad(v_mmsi::TEXT, 9, '0');
    v_mmsi_prefix2 := left(v_mmsi_padded, 2);
    v_mmsi_prefix3 := left(v_mmsi_padded, 3);

    v_entity_type := CASE
      WHEN v_mmsi_prefix2 = '00'  THEN 'station'
      WHEN v_mmsi_prefix3 = '111' THEN 'sar_aircraft'
      WHEN v_mmsi_prefix2 = '99'  THEN 'aton'
      WHEN v_mmsi_prefix3 IN ('970','972','974') THEN 'beacon'
      ELSE 'vessel'
    END;

    -- === FIND OR CREATE ENTITY (match on MMSI across all types) ===
    SELECT entity_id INTO v_entity_id
    FROM entities
    WHERE domain_meta->>'mmsi' = v_mmsi_padded
    LIMIT 1;

    IF v_entity_id IS NULL THEN
      -- Also try legacy non-padded match, so we don't duplicate existing rows.
      SELECT entity_id INTO v_entity_id
      FROM entities
      WHERE domain_meta->>'mmsi' = v_mmsi::TEXT
      LIMIT 1;
    END IF;

    IF v_entity_id IS NULL THEN
      INSERT INTO entities (entity_type, display_name, domain_meta)
      VALUES (
        v_entity_type,
        v_name,
        jsonb_build_object(
          'mmsi', v_mmsi_padded,
          'mmsi_int', v_mmsi,
          'vessel_name', v_name,
          'classified_as', v_entity_type
        )
      )
      RETURNING entity_id INTO v_entity_id;
    ELSE
      -- Keep metadata fresh: normalise MMSI to padded form, refresh name if new.
      UPDATE entities
      SET domain_meta = domain_meta
            || jsonb_build_object('mmsi', v_mmsi_padded, 'mmsi_int', v_mmsi)
            || CASE WHEN v_name IS NOT NULL
                    THEN jsonb_build_object('vessel_name', v_name)
                    ELSE '{}'::jsonb END,
          display_name = COALESCE(v_name, display_name),
          updated_at = now()
      WHERE entity_id = v_entity_id
        AND (
          domain_meta->>'mmsi' IS DISTINCT FROM v_mmsi_padded
          OR (v_name IS NOT NULL AND (display_name IS NULL OR display_name <> v_name))
        );
    END IF;

    -- === BUILD SENSORS JSONB ===
    v_sensors := jsonb_strip_nulls(jsonb_build_object(
      'sog_kn', v_sog,
      'cog', v_cog,
      'hdg', v_hdg
    ));
    IF v_sensors = '{}'::jsonb THEN v_sensors := NULL; END IF;

    -- === INSERT POSITION (append-only) ===
    INSERT INTO positions_v2 (entity_id, lon, lat, alt, t, source_id, sensors)
    VALUES (v_entity_id, v_lon, v_lat, v_alt, v_t, v_source_id, v_sensors);

    -- === UPSERT ENTITY_LAST (live cache) ===
    INSERT INTO entity_last (entity_id, lat, lon, alt, speed, bearing, t, source, source_id, source_count, sensors, updated_at)
    VALUES (
      v_entity_id, v_lat, v_lon, v_alt,
      COALESCE(v_sog * 0.514444, 0),  -- knots to m/s
      COALESCE(v_cog, 0),
      to_timestamp(v_t),
      p_source_name,
      v_source_id,
      1,
      v_sensors,
      now()
    )
    ON CONFLICT (entity_id) DO UPDATE SET
      lat = EXCLUDED.lat,
      lon = EXCLUDED.lon,
      alt = EXCLUDED.alt,
      speed = EXCLUDED.speed,
      bearing = EXCLUDED.bearing,
      t = EXCLUDED.t,
      source = EXCLUDED.source,
      source_id = EXCLUDED.source_id,
      sensors = EXCLUDED.sensors,
      updated_at = now()
    WHERE entity_last.t < EXCLUDED.t;

    v_accepted := v_accepted + 1;
  END LOOP;

  -- === MERGE EDGE + RPC REASON COUNTERS ===
  -- Produces a single jsonb of integer counters keyed by reason.
  SELECT jsonb_object_agg(key, total)
    INTO v_merged_reasons
    FROM (
      SELECT key, SUM(value::INT) AS total
      FROM (
        SELECT key, value FROM jsonb_each_text(COALESCE(p_edge_reasons, '{}'::jsonb))
        UNION ALL
        SELECT key, value FROM jsonb_each_text(v_rpc_reasons)
      ) u
      WHERE value IS NOT NULL
      GROUP BY key
    ) agg;
  IF v_merged_reasons IS NULL THEN
    v_merged_reasons := '{}'::jsonb;
  END IF;

  -- === LOG STATS (new columns + legacy "rejected" = edge + rpc) ===
  INSERT INTO ingest_stats (
    source_name, accepted, rejected,
    edge_rejected, rpc_rejected, reject_reasons, batch_ms
  )
  VALUES (
    p_source_name,
    v_accepted,
    COALESCE(p_edge_rejected, 0) + v_rpc_rejected,
    COALESCE(p_edge_rejected, 0),
    v_rpc_rejected,
    v_merged_reasons,
    (extract(epoch from clock_timestamp()) * 1000 - v_start_ms)::INT
  );

  RETURN jsonb_build_object(
    'accepted', v_accepted,
    'rejected', v_rpc_rejected,
    'reject_reasons', v_rpc_reasons
  );
END;
$function$
;
