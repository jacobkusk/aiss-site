CREATE OR REPLACE FUNCTION public.cleanup_heal_log()
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  DELETE FROM heal_log WHERE ts < now() - interval '7 days';
$function$
;
