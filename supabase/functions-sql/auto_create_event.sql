CREATE OR REPLACE FUNCTION public.auto_create_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.severity IN ('critical', 'high') THEN
    INSERT INTO waveo.events (alert_id, mmsi, title, severity)
    VALUES (
      NEW.id,
      NEW.mmsi,
      NEW.title,
      NEW.severity
    );
    
    -- Bump infrastructure risk score if infrastructure-related
    IF NEW.alert_type = 'infrastructure_proximity' AND NEW.metadata->>'zone_id' IS NOT NULL THEN
      UPDATE infrastructure_zones
      SET risk_score = LEAST(100, risk_score + 5),
          incident_count = incident_count + 1,
          last_incident_at = NOW()
      WHERE id = (NEW.metadata->>'zone_id')::int;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$
;
