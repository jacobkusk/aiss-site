CREATE OR REPLACE FUNCTION public.update_vessel_prediction()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  prev RECORD;
  deviation REAL := 0;
  pred_5 GEOGRAPHY;
  pred_15 GEOGRAPHY;
  actual_lat DOUBLE PRECISION;
  actual_lon DOUBLE PRECISION;
  predicted_lat DOUBLE PRECISION;
  predicted_lon DOUBLE PRECISION;
BEGIN
  -- Calculate predicted positions
  actual_lat := ST_Y(NEW.position::geometry);
  actual_lon := ST_X(NEW.position::geometry);
  
  pred_5 := predict_position(actual_lat, actual_lon, NEW.course, NEW.speed, 5);
  pred_15 := predict_position(actual_lat, actual_lon, NEW.course, NEW.speed, 15);

  -- Check deviation from PREVIOUS prediction
  SELECT * INTO prev FROM vessel_predictions WHERE mmsi = NEW.mmsi;
  
  IF prev IS NOT NULL AND prev.predicted_position_5min IS NOT NULL THEN
    -- How far is actual position from where we predicted it would be?
    deviation := ST_Distance(NEW.position, prev.predicted_position_5min) / 1852.0; -- in nautical miles
    
    -- Normalize: 0-1 nm = normal, 1-5 nm = medium, 5+ nm = high deviation
    deviation := LEAST(100, (deviation / 5.0) * 100);
  END IF;

  -- Upsert prediction
  INSERT INTO vessel_predictions (mmsi, predicted_position_5min, predicted_position_15min,
    deviation_score, last_known_speed, last_known_course, last_position, updated_at)
  VALUES (NEW.mmsi, pred_5, pred_15, deviation, NEW.speed, NEW.course, NEW.position, NOW())
  ON CONFLICT (mmsi) DO UPDATE SET
    predicted_position_5min = pred_5,
    predicted_position_15min = pred_15,
    deviation_score = deviation,
    last_known_speed = NEW.speed,
    last_known_course = NEW.course,
    last_position = NEW.position,
    updated_at = NOW();

  -- Alert on significant deviation (>30 = roughly 1.5nm off predicted course)
  IF deviation > 30 AND NEW.speed > 2.0 THEN
    -- Check if near infrastructure (deviation near infra = extra concerning)
    IF EXISTS (
      SELECT 1 FROM infrastructure_zones
      WHERE active = true
        AND ST_DWithin(zone, pred_15, buffer_meters * 3)
    ) THEN
      -- Only alert once per hour per vessel
      IF NOT EXISTS (
        SELECT 1 FROM vessel_alerts
        WHERE mmsi = NEW.mmsi
          AND alert_type = 'route_deviation'
          AND timestamp > NOW() - INTERVAL '1 hour'
      ) THEN
        INSERT INTO vessel_alerts (mmsi, alert_type, severity, title, description, position, metadata)
        VALUES (
          NEW.mmsi,
          'route_deviation',
          CASE WHEN deviation > 60 THEN 'high' ELSE 'medium' END,
          'Vessel deviating from predicted course toward infrastructure',
          (SELECT name FROM vessels WHERE mmsi = NEW.mmsi) ||
            ' deviated ' || ROUND(deviation::numeric) || '% from predicted course, heading toward critical infrastructure',
          NEW.position,
          jsonb_build_object(
            'deviation_score', ROUND(deviation::numeric),
            'predicted_lat', ST_Y(pred_15::geometry),
            'predicted_lon', ST_X(pred_15::geometry),
            'actual_speed', NEW.speed,
            'actual_course', NEW.course
          )
        );
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;
