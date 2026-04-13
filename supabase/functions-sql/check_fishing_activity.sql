CREATE OR REPLACE FUNCTION public.check_fishing_activity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  zone RECORD;
  is_fishing_vessel BOOLEAN;
  is_trawling_speed BOOLEAN;
BEGIN
  -- Only check fishing vessels (AIS ship_type 30)
  SELECT (ship_type = 30) INTO is_fishing_vessel
  FROM vessels WHERE mmsi = NEW.mmsi;
  
  IF NOT is_fishing_vessel THEN RETURN NEW; END IF;
  
  -- Trawling speed pattern: 2-5 knots with frequent course changes
  is_trawling_speed := NEW.speed BETWEEN 2.0 AND 5.5;
  
  FOR zone IN
    SELECT iz.id, iz.name, iz.severity
    FROM infrastructure_zones iz
    WHERE iz.active = true
      AND iz.zone_type = 'fishing_restricted'
      AND ST_DWithin(iz.zone, NEW.position, iz.buffer_meters)
  LOOP
    -- Skip if already alerted this hour
    IF EXISTS (
      SELECT 1 FROM vessel_alerts
      WHERE mmsi = NEW.mmsi
        AND alert_type = 'illegal_fishing'
        AND metadata->>'zone_id' = zone.id::text
        AND timestamp > NOW() - INTERVAL '1 hour'
    ) THEN
      CONTINUE;
    END IF;

    -- Skip if whitelisted
    IF EXISTS (
      SELECT 1 FROM vessel_zone_whitelist
      WHERE mmsi = NEW.mmsi AND zone_id = zone.id
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO vessel_alerts (mmsi, alert_type, severity, title, description, position, metadata)
    VALUES (
      NEW.mmsi,
      'illegal_fishing',
      CASE WHEN is_trawling_speed THEN 'high' ELSE 'medium' END,
      CASE WHEN is_trawling_speed 
        THEN 'Fishing vessel trawling in restricted zone'
        ELSE 'Fishing vessel in restricted zone'
      END,
      (SELECT name FROM vessels WHERE mmsi = NEW.mmsi) || 
        CASE WHEN is_trawling_speed THEN ' appears to be trawling' ELSE ' detected' END ||
        ' in ' || zone.name || ' at ' || NEW.speed || ' kn',
      NEW.position,
      jsonb_build_object(
        'zone_id', zone.id,
        'zone_name', zone.name,
        'vessel_speed', NEW.speed,
        'vessel_course', NEW.course,
        'is_trawling_speed', is_trawling_speed
      )
    );
  END LOOP;

  RETURN NEW;
END;
$function$
;
