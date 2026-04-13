CREATE OR REPLACE FUNCTION public.check_infrastructure_proximity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  infra RECORD;
BEGIN
  IF NEW.speed IS NULL OR NEW.speed < 0.5 THEN RETURN NEW; END IF;

  FOR infra IN
    SELECT iz.id, iz.name, iz.zone_type, iz.severity, iz.buffer_meters
    FROM infrastructure_zones iz
    WHERE iz.active = true
      AND ST_DWithin(iz.zone, NEW.position, iz.buffer_meters)
  LOOP
    -- Skip if whitelisted
    IF EXISTS (
      SELECT 1 FROM vessel_zone_whitelist
      WHERE mmsi = NEW.mmsi AND zone_id = infra.id
    ) THEN
      -- Still count the pass silently
      UPDATE vessel_zone_whitelist 
      SET pass_count = pass_count + 1 
      WHERE mmsi = NEW.mmsi AND zone_id = infra.id;
      CONTINUE;
    END IF;

    -- Skip if already alerted within 1 hour
    IF EXISTS (
      SELECT 1 FROM vessel_alerts
      WHERE mmsi = NEW.mmsi
        AND alert_type = 'infrastructure_proximity'
        AND metadata->>'zone_id' = infra.id::text
        AND timestamp > NOW() - INTERVAL '1 hour'
    ) THEN
      CONTINUE;
    END IF;

    -- Check vessel trust - high trust = lower severity
    DECLARE
      vessel_trust INT;
      adjusted_severity TEXT;
    BEGIN
      SELECT trust_score INTO vessel_trust 
      FROM vessel_baselines WHERE mmsi = NEW.mmsi;
      
      vessel_trust := COALESCE(vessel_trust, 50);
      
      adjusted_severity := CASE
        WHEN vessel_trust > 80 THEN 'low' -- trusted vessel, just log it
        WHEN vessel_trust > 60 THEN 
          CASE WHEN infra.severity = 'critical' THEN 'medium' ELSE 'low' END
        ELSE infra.severity -- unknown vessel, full severity
      END;

      INSERT INTO vessel_alerts (mmsi, alert_type, severity, title, description, position, metadata)
      VALUES (
        NEW.mmsi,
        'infrastructure_proximity',
        adjusted_severity,
        'Vessel near ' || infra.name,
        (SELECT name FROM vessels WHERE mmsi = NEW.mmsi) || ' within ' || infra.buffer_meters || 'm of ' || infra.name,
        NEW.position,
        jsonb_build_object(
          'zone_id', infra.id,
          'zone_name', infra.name,
          'zone_type', infra.zone_type,
          'vessel_speed', NEW.speed,
          'vessel_course', NEW.course,
          'vessel_trust', vessel_trust
        )
      );
    END;
  END LOOP;

  RETURN NEW;
END;
$function$
;
