CREATE OR REPLACE FUNCTION public.queue_ai_analysis()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.severity IN ('critical', 'high') THEN
    INSERT INTO ai_analysis_queue (queue_type, payload, priority)
    VALUES (
      'alert_assessment',
      jsonb_build_object(
        'alert_id', NEW.id,
        'alert_type', NEW.alert_type,
        'mmsi', NEW.mmsi,
        'vessel_name', (SELECT name FROM vessels WHERE mmsi = NEW.mmsi),
        'vessel_type', (SELECT ship_type FROM vessels WHERE mmsi = NEW.mmsi),
        'flag_country', (SELECT country FROM flags_of_convenience WHERE mid_prefix = (NEW.mmsi / 1000000)::int),
        'trust_score', (SELECT trust_score FROM vessel_baselines WHERE mmsi = NEW.mmsi),
        'risk_score', (SELECT risk_score FROM vessel_risk_profiles WHERE mmsi = NEW.mmsi),
        'alert_title', NEW.title,
        'alert_description', NEW.description,
        'severity', NEW.severity,
        'position', ST_AsGeoJSON(NEW.position),
        'metadata', NEW.metadata,
        'recent_alerts', (
          SELECT jsonb_agg(jsonb_build_object(
            'type', alert_type, 'severity', severity, 
            'title', title, 'timestamp', timestamp
          ))
          FROM vessel_alerts
          WHERE mmsi = NEW.mmsi
            AND id != NEW.id
            AND timestamp > NOW() - INTERVAL '7 days'
          LIMIT 10
        ),
        'ais_gaps', (SELECT ais_gaps_count FROM vessel_risk_profiles WHERE mmsi = NEW.mmsi),
        'flag_changes', (SELECT flag_changes FROM vessel_risk_profiles WHERE mmsi = NEW.mmsi),
        'deviation_score', (SELECT deviation_score FROM vessel_predictions WHERE mmsi = NEW.mmsi)
      ),
      CASE NEW.severity WHEN 'critical' THEN 1 ELSE 3 END
    );
  END IF;
  
  RETURN NEW;
END;
$function$
;
