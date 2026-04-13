CREATE OR REPLACE FUNCTION public.check_geofence_violation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  fence RECORD;
BEGIN
  -- Only check if speed > 0
  IF NEW.speed IS NULL OR NEW.speed < 0.5 THEN RETURN NEW; END IF;

  FOR fence IN
    SELECT g.id, g.org_id, g.speed_limit_knots, g.zone_type, g.name
    FROM waveo.geofences g
    WHERE g.active = true
      AND g.speed_limit_knots IS NOT NULL
      AND ST_DWithin(g.zone, NEW.position, 0)
      AND NEW.speed > g.speed_limit_knots
  LOOP
    INSERT INTO waveo.violations (
      org_id, geofence_id, mmsi, vessel_name,
      violation_type, recorded_speed, speed_limit,
      position, timestamp
    ) VALUES (
      fence.org_id, fence.id, NEW.mmsi,
      (SELECT name FROM vessels WHERE mmsi = NEW.mmsi),
      'speed', NEW.speed, fence.speed_limit_knots,
      NEW.position, NEW.timestamp
    );
  END LOOP;

  RETURN NEW;
END;
$function$
;
