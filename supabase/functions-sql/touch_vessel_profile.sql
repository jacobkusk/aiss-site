CREATE OR REPLACE FUNCTION public.touch_vessel_profile()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;
