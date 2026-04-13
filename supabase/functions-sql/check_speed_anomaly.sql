CREATE OR REPLACE FUNCTION public.check_speed_anomaly()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  prev_speed REAL;
  near_infra BOOLEAN;
BEGIN
  -- Get previous speed
  SELECT speed INTO prev_speed
  FROM ais_positions
  WHERE mmsi = NEW.mmsi AND id != NEW.id
  ORDER BY timestamp DESC LIMIT 1;

  -- No previous record, skip
  IF prev_speed IS NULL THEN RETURN NEW; END IF;

  -- Sudden speed drop > 5 knots
  IF prev_speed - COALESCE(NEW.speed, 0) > 5.0 THEN
    -- Check if near infrastructure
    SELECT EXISTS (
      SELECT 1 FROM infrastructure_zones
      WHERE active = true
        AND ST_DWithin(zone, NEW.position, buffer_meters * 2)
    ) INTO near_infra;

    IF near_infra THEN
      INSERT INTO vessel_alerts (mmsi, alert_type, severity, title, description, position, metadata)
      VALUES (
        NEW.mmsi,
        'speed_anomaly',
        'high',
        'Sudden speed drop near infrastructure',
        (SELECT name FROM vessels WHERE mmsi = NEW.mmsi) || 
          ' dropped from ' || prev_speed || ' kn to ' || COALESCE(NEW.speed, 0) || ' kn near critical infrastructure',
        NEW.position,
        jsonb_build_object(
          'speed_before', prev_speed,
          'speed_after', NEW.speed,
          'drop_knots', prev_speed - COALESCE(NEW.speed, 0)
        )
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;
