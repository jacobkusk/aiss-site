CREATE OR REPLACE FUNCTION public.get_rpc_health()
 RETURNS TABLE(rpc_name text, ok boolean, detail text, checked_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT DISTINCT ON (rpc_name)
    rpc_name, ok, detail, checked_at
  FROM rpc_health
  ORDER BY rpc_name, checked_at DESC;
$function$
;
