CREATE OR REPLACE FUNCTION public.insert_land_polygon(wkt text)
 RETURNS void
 LANGUAGE sql
AS $function$
  INSERT INTO land_polygons (geom)
  VALUES (ST_SetSRID(ST_GeomFromText(wkt), 4326));
$function$
;
