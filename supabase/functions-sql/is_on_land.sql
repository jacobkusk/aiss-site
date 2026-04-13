CREATE OR REPLACE FUNCTION public.is_on_land(p_lon double precision, p_lat double precision)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM land_polygons
    WHERE ST_Within(
      ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326),
      geom
    )
  );
$function$
;
