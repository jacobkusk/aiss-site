CREATE OR REPLACE FUNCTION public.check_ais_spoofing()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  prev_pos GEOGRAPHY;
  prev_time TIMESTAMPTZ;
  distance_nm REAL;
  time_hours REAL;
  implied_speed REAL;
BEGIN
  -- Get previous position
  SELECT position, timestamp INTO prev_pos, prev_time
  FROM ais_positions
  WHERE mmsi = NEW.mmsi AND id != NEW.id
  ORDER BY timestamp DESC LIMIT 1;

  IF prev_pos IS NULL OR prev_time IS NULL THEN RETURN NEW; END IF;

  time_hours := EXTRACT(EPOCH FROM (NEW.timestamp - prev_time)) / 3600.0;
  IF time_hours < 0.001 THEN RETURN NEW; END IF; -- skip near-simultaneous

  distance_nm := ST_Distance(NEW.position, prev_pos) / 1852.0;
  implied_speed := distance_nm / time_hours;

  -- If implied speed > 60 knots, it's likely spoofing or teleportation
  IF implied_speed > 60 THEN
    IF NOT EXISTS (
      SELECT 1 FROM vessel_alerts
      WHERE mmsi = NEW.mmsi
        AND alert_type = 'ais_spoofing'
        AND timestamp > NOW() - INTERVAL '1 hour'
    ) THEN
      INSERT INTO vessel_alerts (mmsi, alert_type, severity, title, description, position, metadata)
      VALUES (
        NEW.mmsi,
        'ais_spoofing',
        'critical',
        'Possible AIS spoofing detected',
        (SELECT name FROM vessels WHERE mmsi = NEW.mmsi) ||
          ' jumped ' || ROUND(distance_nm::numeric, 1) || ' nm in ' || 
          ROUND((time_hours * 60)::numeric, 1) || ' minutes (implied ' || 
          ROUND(implied_speed::numeric) || ' kn)',
        NEW.position,
        jsonb_build_object(
          'distance_nm', ROUND(distance_nm::numeric, 1),
          'time_minutes', ROUND((time_hours * 60)::numeric, 1),
          'implied_speed_kn', ROUND(implied_speed::numeric),
          'reported_speed', NEW.speed
        )
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;
