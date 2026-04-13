CREATE OR REPLACE FUNCTION public.predict_position(p_lat double precision, p_lon double precision, p_cog real, p_sog real, p_minutes real)
 RETURNS geography
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  distance_nm REAL;
  distance_m REAL;
  bearing_rad REAL;
  lat_rad REAL;
  lon_rad REAL;
  new_lat_rad REAL;
  new_lon_rad REAL;
  R REAL := 6371000; -- earth radius meters
BEGIN
  IF p_sog IS NULL OR p_sog < 0.5 OR p_cog IS NULL THEN
    RETURN ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography;
  END IF;
  
  distance_nm := p_sog * (p_minutes / 60.0);
  distance_m := distance_nm * 1852;
  bearing_rad := radians(p_cog);
  lat_rad := radians(p_lat);
  lon_rad := radians(p_lon);
  
  new_lat_rad := asin(
    sin(lat_rad) * cos(distance_m / R) +
    cos(lat_rad) * sin(distance_m / R) * cos(bearing_rad)
  );
  new_lon_rad := lon_rad + atan2(
    sin(bearing_rad) * sin(distance_m / R) * cos(lat_rad),
    cos(distance_m / R) - sin(lat_rad) * sin(new_lat_rad)
  );
  
  RETURN ST_SetSRID(ST_MakePoint(degrees(new_lon_rad), degrees(new_lat_rad)), 4326)::geography;
END;
$function$
;
