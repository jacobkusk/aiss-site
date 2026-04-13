CREATE OR REPLACE FUNCTION public.get_vessel_track(p_mmsi bigint, p_minutes integer DEFAULT 2880)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
  v_entity_id  uuid;
  cutoff_epoch float := extract(epoch from now() - make_interval(mins => p_minutes));
  result       jsonb;
BEGIN
  -- Resolve entity from MMSI
  SELECT entity_id INTO v_entity_id
  FROM entities
  WHERE (domain_meta->>'mmsi')::bigint = p_mmsi
  LIMIT 1;

  IF v_entity_id IS NULL THEN
    RETURN jsonb_build_object(
      'type', 'FeatureCollection',
      'features', '[]'::jsonb,
      'stats', jsonb_build_object('max_speed', null, 'avg_speed_moving', null)
    );
  END IF;

  WITH
  -- One point per integer-second bucket, prefer exact integer t when duplicates exist
  raw_points AS (
    SELECT DISTINCT ON (t::bigint)
      lon, lat, t,
      (sensors->>'sog_kn')::float AS sog,
      (sensors->>'cog')::float    AS cog,
      (sensors->>'hdg')::float    AS hdg
    FROM positions_v2
    WHERE entity_id = v_entity_id
      AND t >= cutoff_epoch
    ORDER BY t::bigint, t DESC
  ),

  -- Add lag columns for dead-reckoning
  scored AS (
    SELECT
      lon, lat, t, sog, cog, hdg,
      LAG(lon) OVER (ORDER BY t) AS prev_lon,
      LAG(lat) OVER (ORDER BY t) AS prev_lat,
      LAG(sog) OVER (ORDER BY t) AS prev_sog,
      LAG(cog) OVER (ORDER BY t) AS prev_cog,
      LAG(t)   OVER (ORDER BY t) AS prev_t
    FROM raw_points
  ),

  -- Dead-reckoning residual score (0.0 = on course, 1.0 = sharp manoeuvre)
  prediction_scored AS (
    SELECT
      lon, lat, t, sog, cog, hdg,
      CASE
        WHEN prev_t IS NULL                    THEN NULL  -- first point
        WHEN (t - prev_t) < 5                 THEN NULL  -- too close
        WHEN prev_sog IS NULL OR prev_sog < 0.5 THEN NULL  -- stationary
        WHEN (t - prev_t) > 1800              THEN NULL  -- gap > 30 min
        ELSE LEAST(1.0,
          ST_DistanceSphere(
            ST_MakePoint(
              prev_lon + (prev_sog * 0.514444 * (t - prev_t))
                         * sin(radians(prev_cog))
                         / (cos(radians(prev_lat)) * 111320.0),
              prev_lat + (prev_sog * 0.514444 * (t - prev_t))
                         * cos(radians(prev_cog))
                         / 111320.0
            ),
            ST_MakePoint(lon, lat)
          ) / NULLIF(prev_sog * 0.514444 * (t - prev_t), 0)
        )
      END AS prediction_score
    FROM scored
  ),

  point_features AS (
    SELECT jsonb_build_object(
      'type', 'Feature',
      'geometry', jsonb_build_object(
        'type', 'Point',
        'coordinates', jsonb_build_array(lon, lat)
      ),
      'properties', jsonb_build_object(
        'mmsi',              p_mmsi,
        'speed',             sog,
        'heading',           hdg,
        'course',            cog,
        'recorded_at',       to_timestamp(t),
        'sources',           1,
        'prediction_score',  ROUND(prediction_score::numeric, 3),
        'prediction_color',  CASE
          WHEN prediction_score IS NULL OR prediction_score <= 0.15 THEN '#00e676'
          WHEN prediction_score <= 0.33                             THEN '#ffeb3b'
          WHEN prediction_score <= 0.50                             THEN '#ff9800'
          ELSE                                                           '#f44336'
        END
      )
    ) AS feature
    FROM prediction_scored
    ORDER BY t
  ),

  speed_stats AS (
    SELECT
      ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY sog)::numeric, 1) AS max_speed,
      ROUND(AVG(sog) FILTER (WHERE sog > 0.5)::numeric, 1)                 AS avg_speed_moving
    FROM prediction_scored
    WHERE sog IS NOT NULL AND sog > 0 AND sog <= 45
  )

  SELECT jsonb_build_object(
    'type',     'FeatureCollection',
    'features', COALESCE((SELECT jsonb_agg(feature) FROM point_features), '[]'::jsonb),
    'stats',    (SELECT jsonb_build_object(
                  'max_speed',        max_speed,
                  'avg_speed_moving', avg_speed_moving
                ) FROM speed_stats)
  ) INTO result;

  RETURN result;
END;
$function$
;
