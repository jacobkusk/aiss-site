CREATE OR REPLACE FUNCTION public.ingest_positions_v2(p_rows jsonb, p_source_name text DEFAULT 'pi4_rtlsdr'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  r             JSONB;
  v_mmsi        BIGINT;
  v_lat         DOUBLE PRECISION;
  v_lon         DOUBLE PRECISION;
  v_alt         DOUBLE PRECISION;
  v_t           DOUBLE PRECISION;
  v_sog         DOUBLE PRECISION;
  v_cog         DOUBLE PRECISION;
  v_hdg         DOUBLE PRECISION;
  v_name        TEXT;
  v_entity_id   UUID;
  v_source_id   UUID;
  v_sensors     JSONB;
  v_accepted    INT := 0;
  v_rejected    INT := 0;
  v_start_ms    DOUBLE PRECISION;
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

    -- === VALIDATION (hard rules — reject if fails) ===
    
    -- MMSI must be 9 digits
    IF v_mmsi IS NULL OR v_mmsi < 100000000 OR v_mmsi > 999999999 THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;

    -- Coordinates must be valid
    IF v_lat IS NULL OR v_lon IS NULL THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;
    IF v_lat < -90 OR v_lat > 90 OR v_lon < -180 OR v_lon > 180 THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;

    -- Null Island rejection
    IF v_lat = 0 AND v_lon = 0 THEN
      v_rejected := v_rejected + 1; CONTINUE;
    END IF;

    -- === FIND OR CREATE ENTITY ===
    SELECT entity_id INTO v_entity_id
    FROM entities
    WHERE domain_meta->>'mmsi' = v_mmsi::TEXT AND entity_type = 'vessel'
    LIMIT 1;

    IF v_entity_id IS NULL THEN
      INSERT INTO entities (entity_type, display_name, domain_meta)
      VALUES (
        'vessel',
        v_name,
        jsonb_build_object('mmsi', v_mmsi, 'vessel_name', v_name)
      )
      RETURNING entity_id INTO v_entity_id;
    ELSIF v_name IS NOT NULL THEN
      -- Update name if we have a new one
      UPDATE entities
      SET domain_meta = domain_meta || jsonb_build_object('vessel_name', v_name),
          display_name = v_name,
          updated_at = now()
      WHERE entity_id = v_entity_id AND (display_name IS NULL OR display_name != v_name);
    END IF;

    -- === BUILD SENSORS JSONB ===
    v_sensors := jsonb_strip_nulls(jsonb_build_object(
      'sog_kn', v_sog,
      'cog', v_cog,
      'hdg', v_hdg
    ));
    IF v_sensors = '{}'::jsonb THEN v_sensors := NULL; END IF;

    -- === INSERT POSITION (append-only, ~1ms) ===
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
    WHERE entity_last.t < EXCLUDED.t;  -- only update if newer

    v_accepted := v_accepted + 1;
  END LOOP;

  -- === LOG STATS ===
  INSERT INTO ingest_stats (source_name, accepted, rejected, batch_ms)
  VALUES (
    p_source_name,
    v_accepted,
    v_rejected,
    (extract(epoch from clock_timestamp()) * 1000 - v_start_ms)::INT
  );

  RETURN jsonb_build_object('accepted', v_accepted, 'rejected', v_rejected);
END;
$function$
;
