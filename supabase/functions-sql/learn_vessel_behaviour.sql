CREATE OR REPLACE FUNCTION public.learn_vessel_behaviour()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  pass_threshold INT := 5; -- after 5 clean passes, auto-whitelist
  existing_count INT;
BEGIN
  -- Only for infrastructure_proximity alerts
  IF NEW.alert_type != 'infrastructure_proximity' THEN RETURN NEW; END IF;

  -- Count how many times this vessel has passed this zone
  SELECT count(*) INTO existing_count
  FROM vessel_alerts
  WHERE mmsi = NEW.mmsi
    AND alert_type = 'infrastructure_proximity'
    AND metadata->>'zone_id' = NEW.metadata->>'zone_id'
    AND timestamp > NOW() - INTERVAL '90 days';

  -- If vessel passes regularly, auto-whitelist and suppress future alerts
  IF existing_count >= pass_threshold THEN
    INSERT INTO vessel_zone_whitelist (mmsi, zone_id, reason, auto_learned, pass_count)
    VALUES (
      NEW.mmsi,
      (NEW.metadata->>'zone_id')::int,
      'auto_learned_regular',
      true,
      existing_count
    )
    ON CONFLICT (mmsi, zone_id) DO UPDATE SET
      pass_count = EXCLUDED.pass_count,
      created_at = NOW();
  END IF;

  -- Update baseline trust score
  INSERT INTO vessel_baselines (mmsi, observations, trust_score)
  VALUES (NEW.mmsi, 1, 50)
  ON CONFLICT (mmsi) DO UPDATE SET
    observations = vessel_baselines.observations + 1,
    -- Trust increases with consistent behaviour
    trust_score = LEAST(100, vessel_baselines.trust_score + 1),
    updated_at = NOW();

  RETURN NEW;
END;
$function$
;
