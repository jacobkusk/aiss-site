CREATE OR REPLACE FUNCTION public.get_system_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE result jsonb;
BEGIN
  WITH
  totals AS (
    SELECT
      COUNT(*)                                                                     AS total_positions,
      COUNT(*) FILTER (WHERE t >= extract(epoch from now()::date))                AS positions_today,
      COUNT(*) FILTER (WHERE t >= extract(epoch from now() - interval '1 hour'))  AS positions_last_hour
    FROM positions_v2
  ),
  vessels    AS (SELECT COUNT(*) AS total_vessels FROM entities),
  vessels_today AS (
    SELECT COUNT(DISTINCT entity_id) AS n FROM positions_v2
    WHERE t >= extract(epoch from now()::date)
  ),
  first_seen AS (
    SELECT entity_id, MIN(t) AS first_t FROM positions_v2 GROUP BY entity_id
  ),
  new_vessels_today AS (
    SELECT COUNT(*) AS n FROM first_seen WHERE first_t >= extract(epoch from now()::date)
  ),
  new_vessels_week AS (
    SELECT COUNT(*) AS n FROM first_seen WHERE first_t >= extract(epoch from now() - interval '7 days')
  ),
  db_size AS (
    SELECT
      pg_size_pretty(COALESCE(SUM(pg_total_relation_size(inhrelid)), 0)) AS size,
      COALESCE(SUM(pg_total_relation_size(inhrelid)), 0)                 AS size_bytes
    FROM pg_inherits WHERE inhparent = 'positions_v2'::regclass
  ),
  partitions AS (
    SELECT COUNT(*) AS n FROM pg_inherits WHERE inhparent = 'positions_v2'::regclass
  ),
  -- Positioner pr. dag (seneste 7 dage)
  daily AS (
    SELECT date_trunc('day', to_timestamp(t))::date AS day, COUNT(*) AS n
    FROM positions_v2
    WHERE t >= extract(epoch from now() - interval '7 days')
    GROUP BY 1 ORDER BY 1
  ),
  -- Nye skibe pr. dag + kumulativ total (hele historikken)
  vessels_per_day AS (
    SELECT
      date_trunc('day', to_timestamp(first_t))::date AS day,
      COUNT(*)                                        AS new_vessels
    FROM first_seen
    GROUP BY 1 ORDER BY 1
  ),
  vessels_cumulative AS (
    SELECT
      day,
      new_vessels,
      SUM(new_vessels) OVER (ORDER BY day)::int AS cumulative
    FROM vessels_per_day
  ),
  sources AS (
    SELECT
      s.source_id, s.name AS source_name, s.source_type, s.is_active,
      MAX(i.ts)                               AS last_seen,
      EXTRACT(EPOCH FROM (now() - MAX(i.ts))) AS age_sec,
      COUNT(i.id)                             AS total_batches,
      COALESCE(SUM(i.accepted), 0)            AS total_accepted,
      COALESCE(SUM(i.rejected), 0)            AS total_rejected
    FROM ingest_sources s
    LEFT JOIN ingest_stats i ON i.source_name = s.name
    GROUP BY s.source_id, s.name, s.source_type, s.is_active
  )
  SELECT jsonb_build_object(
    'total_positions',     (SELECT total_positions FROM totals),
    'positions_today',     (SELECT positions_today FROM totals),
    'positions_last_hour', (SELECT positions_last_hour FROM totals),
    'total_vessels',       (SELECT total_vessels FROM vessels),
    'vessels_today',       (SELECT n FROM vessels_today),
    'new_vessels_today',   (SELECT n FROM new_vessels_today),
    'new_vessels_week',    (SELECT n FROM new_vessels_week),
    'db_size',             (SELECT size FROM db_size),
    'db_size_bytes',       (SELECT size_bytes FROM db_size),
    'partition_count',     (SELECT n FROM partitions),
    'daily_positions',     COALESCE((SELECT jsonb_agg(jsonb_build_object('day', day, 'n', n) ORDER BY day) FROM daily), '[]'),
    'vessels_growth',      COALESCE((SELECT jsonb_agg(jsonb_build_object('day', day, 'new', new_vessels, 'total', cumulative) ORDER BY day) FROM vessels_cumulative), '[]'),
    'sources', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'source_id',      source_id,
        'source_name',    source_name,
        'source_type',    source_type,
        'is_active',      is_active,
        'last_seen',      last_seen,
        'age_sec',        age_sec,
        'status',         CASE
                            WHEN NOT is_active     THEN 'inactive'
                            WHEN last_seen IS NULL THEN 'down'
                            WHEN age_sec < 300     THEN 'ok'
                            WHEN age_sec < 1800    THEN 'stale'
                            ELSE                        'down'
                          END,
        'total_batches',  total_batches,
        'total_accepted', total_accepted,
        'total_rejected', total_rejected
      ) ORDER BY is_active DESC, source_name) FROM sources
    ), '[]')
  ) INTO result;
  RETURN result;
END;
$function$
;
