CREATE OR REPLACE FUNCTION public.scan_for_patterns()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  infra RECORD;
BEGIN
  -- Check each infrastructure zone for multiple vessels nearby
  FOR infra IN
    SELECT iz.id, iz.name, iz.zone_type,
      count(DISTINCT a.mmsi) as vessel_count,
      jsonb_agg(DISTINCT jsonb_build_object(
        'mmsi', a.mmsi,
        'name', v.name,
        'speed', a.speed,
        'course', a.course,
        'flag', (SELECT country FROM flags_of_convenience WHERE mid_prefix = (a.mmsi / 1000000)::int)
      )) as vessels_near
    FROM infrastructure_zones iz
    JOIN ais_positions a ON ST_DWithin(iz.zone, a.position, iz.buffer_meters * 5)
    JOIN vessels v ON v.mmsi = a.mmsi
    WHERE a.timestamp > NOW() - INTERVAL '30 minutes'
      AND a.speed > 0.5
      AND iz.active = true
    GROUP BY iz.id, iz.name, iz.zone_type
    HAVING count(DISTINCT a.mmsi) >= 3
  LOOP
    -- Queue multi-vessel pattern analysis
    IF NOT EXISTS (
      SELECT 1 FROM ai_analysis_queue
      WHERE queue_type = 'multi_vessel'
        AND payload->>'zone_id' = infra.id::text
        AND created_at > NOW() - INTERVAL '1 hour'
    ) THEN
      INSERT INTO ai_analysis_queue (queue_type, payload, priority)
      VALUES (
        'multi_vessel',
        jsonb_build_object(
          'zone_id', infra.id,
          'zone_name', infra.name,
          'zone_type', infra.zone_type,
          'vessel_count', infra.vessel_count,
          'vessels', infra.vessels_near
        ),
        CASE WHEN infra.vessel_count >= 5 THEN 2 ELSE 5 END
      );
    END IF;
  END LOOP;
END;
$function$
;
