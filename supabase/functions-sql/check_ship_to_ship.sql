CREATE OR REPLACE FUNCTION public.check_ship_to_ship()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  nearby RECORD;
  proximity_m REAL := 200;
  in_port BOOLEAN;
BEGIN
  IF NEW.speed IS NULL OR NEW.speed > 3.0 THEN RETURN NEW; END IF;

  -- Skip if inside a known port area
  SELECT EXISTS (
    SELECT 1 FROM port_areas WHERE ST_DWithin(area, NEW.position, 0)
  ) INTO in_port;
  IF in_port THEN RETURN NEW; END IF;

  FOR nearby IN
    SELECT DISTINCT a.mmsi, v.name, a.speed
    FROM ais_positions a
    JOIN vessels v ON v.mmsi = a.mmsi
    WHERE a.mmsi != NEW.mmsi
      AND a.timestamp > NOW() - INTERVAL '5 minutes'
      AND a.speed < 3.0
      AND ST_DWithin(a.position, NEW.position, proximity_m)
    LIMIT 3
  LOOP
    IF EXISTS (
      SELECT 1 FROM vessel_alerts
      WHERE alert_type = 'ship_to_ship'
        AND (
          (mmsi = NEW.mmsi AND metadata->>'other_mmsi' = nearby.mmsi::text)
          OR (mmsi = nearby.mmsi AND metadata->>'other_mmsi' = NEW.mmsi::text)
        )
        AND timestamp > NOW() - INTERVAL '2 hours'
    ) THEN CONTINUE; END IF;

    IF (SELECT trust_score FROM vessel_baselines WHERE mmsi = NEW.mmsi) > 80
       AND (SELECT trust_score FROM vessel_baselines WHERE mmsi = nearby.mmsi) > 80
    THEN CONTINUE; END IF;

    INSERT INTO vessel_alerts (mmsi, alert_type, severity, title, description, position, metadata)
    VALUES (
      NEW.mmsi,
      'ship_to_ship',
      'high',
      'Possible ship-to-ship transfer',
      (SELECT name FROM vessels WHERE mmsi = NEW.mmsi) || ' and ' || 
        COALESCE(nearby.name, 'MMSI ' || nearby.mmsi) ||
        ' within ' || proximity_m || 'm at open sea, both at low speed',
      NEW.position,
      jsonb_build_object(
        'other_mmsi', nearby.mmsi,
        'other_name', nearby.name,
        'other_speed', nearby.speed,
        'vessel_speed', NEW.speed,
        'proximity_m', proximity_m,
        'in_port', false
      )
    );
  END LOOP;

  RETURN NEW;
END;
$function$
;
