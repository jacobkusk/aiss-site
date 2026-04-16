-- Display-name fill-rate diagnostic. Vessel names arrive in AIS type 5
-- messages (static voyage data), which are transmitted much less frequently
-- than positions. If type 5 messages stop flowing (e.g. rtl_ais decoder
-- filter bug, antenna orientation, rain fade), positions still arrive but
-- names go stale → UI shows "MMSI 123456789" instead of "EVER GIVEN".
--
-- Reports: total vessels, % with display_name, and the same broken down
-- to vessels active in the last 24h (more actionable than lifetime stats).
-- Emits WARNING status when the 24h named% drops below 30%.
--
-- Used as a manual diagnostic + as input to the ship_type backfill roadmap
-- item (see CLAUDE.md: "ship_type backfill — uden det ingen LINE-lag").

CREATE OR REPLACE FUNCTION public.check_name_coverage()
 RETURNS TABLE(total_entities bigint, with_name bigint, without_name bigint, name_pct numeric, recent_24h bigint, recent_with_name bigint, recent_name_pct numeric, oldest_nameless_mmsi text, status text)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total bigint;
  v_named bigint;
  v_recent bigint;
  v_recent_named bigint;
  v_status text;
BEGIN
  SELECT count(*), count(display_name)
  INTO v_total, v_named
  FROM entities WHERE entity_type = 'vessel';

  SELECT count(*), count(e.display_name)
  INTO v_recent, v_recent_named
  FROM entity_last el
  JOIN entities e ON e.entity_id = el.entity_id
  WHERE el.updated_at > now() - interval '24 hours';

  -- Alert if less than 30% of recent vessels have names
  IF v_recent > 0 AND (v_recent_named::numeric / v_recent) < 0.3 THEN
    v_status := 'WARNING: low name coverage — type 5 messages may not be flowing';
  ELSE
    v_status := 'OK';
  END IF;

  RETURN QUERY SELECT
    v_total,
    v_named,
    v_total - v_named,
    CASE WHEN v_total > 0 THEN round(100.0 * v_named / v_total, 1) ELSE 0 END,
    v_recent,
    v_recent_named,
    CASE WHEN v_recent > 0 THEN round(100.0 * v_recent_named / v_recent, 1) ELSE 0 END,
    (SELECT domain_meta->>'mmsi' FROM entities
     WHERE entity_type = 'vessel' AND display_name IS NULL
     ORDER BY updated_at DESC LIMIT 1),
    v_status;
END;
$function$
;
