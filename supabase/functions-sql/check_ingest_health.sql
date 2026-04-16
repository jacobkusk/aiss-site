-- Baseline-aware ingest health diagnostic. Compares last hour's accepted
-- positions + unique vessels against a 7-day hourly baseline (excluding the
-- most recent 2 hours so the baseline isn't polluted by the current incident).
--
-- Classifies as:
--   OK       — current >= 30% of baseline, or baseline = 0
--   DEGRADED — current < 30% of baseline
--   DEAD     — 0 positions in the last hour
--
-- Used as a manual diagnostic (documented in docs/PI-OPS.md). NOT on pg_cron —
-- `run_rpc_health_checks` handles the regular scheduled heartbeat via rpc_health.
-- This RPC writes to rpc_health too (rpc_name = 'ingest_health') when invoked.

CREATE OR REPLACE FUNCTION public.check_ingest_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  result jsonb;
  current_rate bigint;
  baseline_rate numeric;
  current_vessels int;
  baseline_vessels numeric;
  health_status text;
  health_detail text;
  is_ok boolean;
BEGIN
  -- Aktuel rate: accepterede positioner seneste time
  SELECT COALESCE(SUM(accepted), 0) INTO current_rate
  FROM ingest_stats
  WHERE ts > NOW() - INTERVAL '1 hour';

  -- Baseline: gennemsnit per time over seneste 7 dage (ekskl. seneste 2 timer)
  SELECT COALESCE(AVG(hourly_sum), 0) INTO baseline_rate
  FROM (
    SELECT date_trunc('hour', ts) as h, SUM(accepted) as hourly_sum
    FROM ingest_stats
    WHERE ts BETWEEN NOW() - INTERVAL '7 days' AND NOW() - INTERVAL '2 hours'
    GROUP BY 1
  ) sub;

  -- Aktuelle unikke skibe seneste time
  SELECT COUNT(DISTINCT entity_id) INTO current_vessels
  FROM entity_last
  WHERE t > NOW() - INTERVAL '1 hour';

  -- Baseline unikke skibe per time
  SELECT COALESCE(AVG(hourly_vessels), 0) INTO baseline_vessels
  FROM (
    SELECT date_trunc('hour', to_timestamp(t)) as h, COUNT(DISTINCT entity_id) as hourly_vessels
    FROM positions_v2
    WHERE to_timestamp(t) BETWEEN NOW() - INTERVAL '7 days' AND NOW() - INTERVAL '2 hours'
    GROUP BY 1
  ) sub;

  -- Vurder status
  IF current_rate = 0 THEN
    health_status := 'DEAD';
    health_detail := 'Ingen positioner modtaget seneste time';
    is_ok := false;
  ELSIF baseline_rate > 0 AND (current_rate::numeric / baseline_rate) < 0.3 THEN
    health_status := 'DEGRADED';
    health_detail := format('Ingest på %s%% af normalt (%s vs baseline %s/t). Skibe: %s (normalt %s)',
      ROUND((current_rate::numeric / baseline_rate) * 100),
      current_rate, ROUND(baseline_rate), current_vessels, ROUND(baseline_vessels));
    is_ok := false;
  ELSE
    health_status := 'OK';
    health_detail := format('Ingest normal: %s pos/t (baseline %s), %s skibe (normalt %s)',
      current_rate, ROUND(baseline_rate), current_vessels, ROUND(baseline_vessels));
    is_ok := true;
  END IF;

  -- Log til rpc_health
  INSERT INTO rpc_health (rpc_name, ok, detail, checked_at)
  VALUES ('ingest_health', is_ok, health_detail, NOW());

  result := jsonb_build_object(
    'status', health_status,
    'ok', is_ok,
    'detail', health_detail,
    'current_rate', current_rate,
    'baseline_rate', ROUND(baseline_rate),
    'current_vessels', current_vessels,
    'baseline_vessels', ROUND(baseline_vessels),
    'checked_at', NOW()
  );

  RETURN result;
END;
$function$
;
