-- Batch Douglas-Peucker compression of positions_v2 into the `tracks` table.
-- Reads ALL positions currently in positions_v2, outlier-trims (2nd/98th
-- percentile per vessel), speed-filters (drops fixes implying > p_max_knots),
-- segments by p_gap_sec gaps, simplifies each segment, and upserts one
-- MULTILINESTRINGZM per entity.
--
-- NOT on pg_cron today — invoked manually when we want to rebuild the
-- compressed track archive. The compress-ais-segments cron currently runs
-- `compress_completed_segments` (per-segment incremental); this function is
-- the "burn it down, build it back" variant used when tuning epsilon/gap.
--
-- Related roadmap item (CLAUDE.md § "D·P signatur — næste build"): sign each
-- compressed track with the raw Merkle root so new compressions become new
-- versions rather than replacements. Current UPSERT behaviour overwrites the
-- existing row — fine for manual rebuilds, wrong for production signatures.
-- Kept as-is here so the source reflects the deployed definition.

CREATE OR REPLACE FUNCTION public.build_dp_tracks(p_epsilon_m double precision DEFAULT 5.0, p_gap_sec double precision DEFAULT 120.0, p_max_knots double precision DEFAULT 15.0)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH t0 AS (SELECT clock_timestamp() AS ts),
  all_pos AS (SELECT entity_id, lon, lat, alt, t FROM positions_v2),
  bounds AS (
    SELECT entity_id,
      percentile_cont(0.02) WITHIN GROUP (ORDER BY lon) AS lon_lo,
      percentile_cont(0.98) WITHIN GROUP (ORDER BY lon) AS lon_hi,
      percentile_cont(0.02) WITHIN GROUP (ORDER BY lat) AS lat_lo,
      percentile_cont(0.98) WITHIN GROUP (ORDER BY lat) AS lat_hi
    FROM all_pos GROUP BY entity_id
  ),
  no_outliers AS (
    SELECT p.entity_id, p.lon, p.lat, p.alt, p.t
    FROM all_pos p JOIN bounds b USING (entity_id)
    WHERE p.lon BETWEEN b.lon_lo AND b.lon_hi
      AND p.lat BETWEEN b.lat_lo AND b.lat_hi
  ),
  with_lag AS (
    SELECT entity_id, lon, lat, alt, t,
      LAG(t)   OVER (PARTITION BY entity_id ORDER BY t) AS prev_t,
      LAG(lon) OVER (PARTITION BY entity_id ORDER BY t) AS prev_lon,
      LAG(lat) OVER (PARTITION BY entity_id ORDER BY t) AS prev_lat
    FROM no_outliers
  ),
  clean_pos AS (
    SELECT entity_id, lon, lat, alt, t, prev_t FROM with_lag
    WHERE prev_t IS NULL OR (t - prev_t) <= 0
    OR ST_Distance(
        ST_SetSRID(ST_MakePoint(lon,lat),4326)::geography,
        ST_SetSRID(ST_MakePoint(prev_lon,prev_lat),4326)::geography
      ) / NULLIF(t - prev_t, 0) * 1.944 <= p_max_knots
  ),
  with_gap_flag AS (
    SELECT entity_id, lon, lat, alt, t,
      CASE WHEN t - prev_t > p_gap_sec OR prev_t IS NULL THEN 1 ELSE 0 END AS is_new_seg
    FROM clean_pos
  ),
  with_seg AS (
    SELECT entity_id, lon, lat, alt, t,
      SUM(is_new_seg) OVER (PARTITION BY entity_id ORDER BY t) AS seg_id
    FROM with_gap_flag
  ),
  seg_lines AS (
    SELECT entity_id, seg_id, COUNT(*) AS cnt,
      ST_MakeLine(ST_MakePoint(lon, lat, COALESCE(alt,0), t) ORDER BY t) AS line
    FROM with_seg GROUP BY entity_id, seg_id
  ),
  vlines AS (
    SELECT entity_id, SUM(cnt) AS n_raw,
      ST_Multi(ST_Collect(ST_Simplify(line, p_epsilon_m/111320.0))) AS track_zm,
      ST_Multi(ST_Collect(ST_Force2D(ST_Simplify(line, p_epsilon_m/111320.0)))) AS track_2d
    FROM seg_lines WHERE cnt >= 2
    GROUP BY entity_id
  ),
  gaps AS (
    SELECT entity_id, jsonb_agg(jsonb_build_array(t, t_next) ORDER BY t) AS g
    FROM (
      SELECT entity_id, t, LEAD(t) OVER (PARTITION BY entity_id ORDER BY t) AS t_next
      FROM clean_pos
    ) s WHERE t_next - t > p_gap_sec GROUP BY entity_id
  ),
  ups AS (
    INSERT INTO tracks (track_id, entity_id, track, track_display, source, source_domain, latency_class, raw_point_count, compressed_point_count, epsilon_m, gap_intervals, compressed_at)
    SELECT gen_random_uuid(), v.entity_id,
      v.track_zm, v.track_2d, 'batch-auto', 'ais', 'live',
      v.n_raw, ST_NPoints(v.track_2d),
      p_epsilon_m, COALESCE(g.g, '[]'::jsonb), now()
    FROM vlines v LEFT JOIN gaps g USING (entity_id)
    ON CONFLICT (entity_id) DO UPDATE SET
      track=EXCLUDED.track, track_display=EXCLUDED.track_display,
      raw_point_count=EXCLUDED.raw_point_count,
      compressed_point_count=EXCLUDED.compressed_point_count,
      gap_intervals=EXCLUDED.gap_intervals, compressed_at=now()
    RETURNING entity_id, raw_point_count, compressed_point_count
  )
  SELECT jsonb_build_object(
    'vessels', COUNT(*), 'total_raw', SUM(raw_point_count),
    'total_dp', SUM(compressed_point_count),
    'elapsed_ms', ROUND(EXTRACT(EPOCH FROM (clock_timestamp()-(SELECT ts FROM t0)))*1000)
  ) FROM ups
$function$
;
