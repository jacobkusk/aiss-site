CREATE OR REPLACE FUNCTION public.expire_live_vessels(p_max_age_minutes integer DEFAULT 120)
 RETURNS TABLE(expired_count integer, removed_entity_ids bigint[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_expired_ids BIGINT[];
  v_count INT;
BEGIN
  -- Find all entities that haven't been updated in the last p_max_age_minutes
  SELECT array_agg(entity_id), count(*)
  INTO v_expired_ids, v_count
  FROM entity_last
  WHERE updated_at < now() - (p_max_age_minutes || ' minutes')::interval;

  -- Delete them
  IF v_count > 0 THEN
    DELETE FROM entity_last
    WHERE updated_at < now() - (p_max_age_minutes || ' minutes')::interval;
  END IF;

  RETURN QUERY SELECT v_count, v_expired_ids;
END;
$function$
;
