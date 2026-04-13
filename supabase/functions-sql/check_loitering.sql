CREATE OR REPLACE FUNCTION public.check_loitering()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  positions_in_area INT;
  time_in_area INTERVAL;
  area_center GEOGRAPHY;
  radius_m REAL := 500; -- 500m radius = same area
  min_positions INT := 10; -- need at least 10 positions
  min_duration INTERVAL := '2 hours';
  near_infra BOOLEAN;
BEGIN
  -- Only check moving vessels (rules out moored)
  IF NEW.speed IS NULL OR NEW.speed < 0.3 OR NEW.speed > 5.0 THEN RETURN NEW; END IF;

  -- Count positions within 500m of current position in last 4 hours
  SELECT count(*), MAX(timestamp) - MIN(timestamp)
  INTO positions_in_area, time_in_area
  FROM ais_positions
  WHERE mmsi = NEW.mmsi
    AND timestamp > NOW() - INTERVAL '4 hours'
    AND ST_DWithin(position, NEW.position, radius_m);

  -- If vessel has been in this 500m circle for 2+ hours with 10+ pings
  IF positions_in_area >= min_positions AND time_in_area >= min_duration THEN
    -- Skip if already alerted
    IF EXISTS (
      SELECT 1 FROM vessel_alerts
      WHERE mmsi = NEW.mmsi
        AND alert_type = 'loitering'
        AND timestamp > NOW() - INTERVAL '4 hours'
    ) THEN RETURN NEW; END IF;

    -- Check if near infrastructure
    SELECT EXISTS (
      SELECT 1 FROM infrastructure_zones
      WHERE active = true AND ST_DWithin(zone, NEW.position, buffer_meters * 3)
    ) INTO near_infra;

    INSERT INTO vessel_alerts (mmsi, alert_type, severity, title, description, position, metadata)
    VALUES (
      NEW.mmsi,
      'loitering',
      CASE WHEN near_infra THEN 'high' ELSE 'medium' END,
      CASE WHEN near_infra 
        THEN 'Vessel loitering near infrastructure'
        ELSE 'Vessel loitering'
      END,
      (SELECT name FROM vessels WHERE mmsi = NEW.mmsi) ||
        ' has been circling same area for ' || 
        EXTRACT(HOURS FROM time_in_area) || 'h ' ||
        EXTRACT(MINUTES FROM time_in_area) || 'm' ||
        CASE WHEN near_infra THEN ' near critical infrastructure' ELSE '' END,
      NEW.position,
      jsonb_build_object(
        'duration_hours', ROUND(EXTRACT(EPOCH FROM time_in_area) / 3600.0, 1),
        'positions_count', positions_in_area,
        'radius_m', radius_m,
        'avg_speed', NEW.speed,
        'near_infrastructure', near_infra
      )
    );
  END IF;

  RETURN NEW;
END;
$function$
;
