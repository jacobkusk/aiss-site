CREATE OR REPLACE FUNCTION public.auto_assign_event_to_circles()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  circle RECORD;
  event_pos GEOGRAPHY;
BEGIN
  -- Get position from the alert or from the event itself
  IF NEW.position IS NOT NULL THEN
    event_pos := NEW.position;
  ELSIF NEW.alert_id IS NOT NULL THEN
    SELECT position INTO event_pos FROM vessel_alerts WHERE id = NEW.alert_id;
  END IF;
  
  IF event_pos IS NULL THEN RETURN NEW; END IF;

  -- Find all circles whose region contains this event
  FOR circle IN
    SELECT id FROM waveo.circles
    WHERE region IS NOT NULL
      AND ST_DWithin(region, event_pos, 0)
  LOOP
    -- Create a copy of the event for this circle if not already assigned
    IF NEW.circle_id IS NULL THEN
      UPDATE waveo.events SET circle_id = circle.id, position = event_pos WHERE id = NEW.id;
      -- Only assign to first matching circle for now
      EXIT;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$
;
