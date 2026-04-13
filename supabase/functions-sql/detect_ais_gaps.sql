CREATE OR REPLACE FUNCTION public.detect_ais_gaps()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO vessel_alerts (mmsi, alert_type, severity, title, description, metadata)
  SELECT 
    v.mmsi,
    'ais_gap',
    CASE 
      WHEN EXTRACT(EPOCH FROM NOW() - MAX(a.timestamp)) > 86400 THEN 'high'
      WHEN EXTRACT(EPOCH FROM NOW() - MAX(a.timestamp)) > 14400 THEN 'medium'
      ELSE 'low'
    END,
    'AIS gap detected',
    v.name || ' has not transmitted for ' || 
      ROUND(EXTRACT(EPOCH FROM NOW() - MAX(a.timestamp)) / 3600) || ' hours',
    jsonb_build_object(
      'last_seen', MAX(a.timestamp),
      'gap_hours', ROUND(EXTRACT(EPOCH FROM NOW() - MAX(a.timestamp)) / 3600),
      'last_speed', (SELECT speed FROM ais_positions WHERE mmsi = v.mmsi ORDER BY timestamp DESC LIMIT 1)
    )
  FROM vessels v
  JOIN ais_positions a ON a.mmsi = v.mmsi
  WHERE v.mmsi IN (
    -- Only vessels we've seen recently that suddenly went quiet
    SELECT DISTINCT mmsi FROM ais_positions 
    WHERE timestamp > NOW() - INTERVAL '48 hours'
  )
  GROUP BY v.mmsi, v.name
  HAVING MAX(a.timestamp) < NOW() - INTERVAL '4 hours'
    AND NOT EXISTS (
      SELECT 1 FROM vessel_alerts 
      WHERE mmsi = v.mmsi AND alert_type = 'ais_gap' 
      AND timestamp > NOW() - INTERVAL '4 hours'
    );
END;
$function$
;
