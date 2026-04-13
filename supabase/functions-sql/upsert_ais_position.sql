CREATE OR REPLACE FUNCTION public.upsert_ais_position(p_mmsi bigint, p_lat double precision, p_lon double precision, p_speed real DEFAULT NULL::real, p_course real DEFAULT NULL::real, p_heading real DEFAULT NULL::real, p_nav_status integer DEFAULT NULL::integer, p_name text DEFAULT NULL::text, p_callsign text DEFAULT NULL::text, p_ship_type integer DEFAULT NULL::integer, p_length real DEFAULT NULL::real, p_width real DEFAULT NULL::real, p_draught real DEFAULT NULL::real, p_destination text DEFAULT NULL::text, p_station_id integer DEFAULT NULL::integer, p_source text DEFAULT 'terrestrial'::text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF p_lat = 0 AND p_lon = 0 THEN RETURN; END IF;
  IF p_lat < -90 OR p_lat > 90 OR p_lon < -180 OR p_lon > 180 THEN RETURN; END IF;
  IF p_mmsi < 200000000 OR p_mmsi > 799999999 THEN RETURN; END IF;

  -- Upsert vessel
  INSERT INTO vessels (mmsi, name, callsign, ship_type, length, width, draught, destination, updated_at)
  VALUES (p_mmsi, p_name, p_callsign, p_ship_type, p_length, p_width, p_draught, p_destination, NOW())
  ON CONFLICT (mmsi) DO UPDATE SET
    name = COALESCE(NULLIF(EXCLUDED.name, ''), vessels.name),
    callsign = COALESCE(NULLIF(EXCLUDED.callsign, ''), vessels.callsign),
    ship_type = COALESCE(EXCLUDED.ship_type, vessels.ship_type),
    length = COALESCE(EXCLUDED.length, vessels.length),
    width = COALESCE(EXCLUDED.width, vessels.width),
    draught = COALESCE(EXCLUDED.draught, vessels.draught),
    destination = COALESCE(NULLIF(EXCLUDED.destination, ''), vessels.destination),
    updated_at = NOW();

  -- Insert position history
  INSERT INTO ais_positions (mmsi, position, speed, course, heading, nav_status, station_id, source, timestamp)
  VALUES (p_mmsi, ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography, p_speed, p_course, p_heading, p_nav_status, p_station_id, p_source, NOW());

  -- Upsert live position with denormalized fields
  INSERT INTO vessels_live (mmsi, position, lat, lon, speed, course, heading, nav_status, name, ship_type, destination, source, updated_at)
  VALUES (p_mmsi, ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography, p_lat, p_lon, p_speed, p_course, p_heading, p_nav_status, p_name, p_ship_type, p_destination, p_source, NOW())
  ON CONFLICT (mmsi) DO UPDATE SET
    position = EXCLUDED.position,
    lat = EXCLUDED.lat,
    lon = EXCLUDED.lon,
    speed = EXCLUDED.speed,
    course = EXCLUDED.course,
    heading = EXCLUDED.heading,
    nav_status = EXCLUDED.nav_status,
    name = COALESCE(NULLIF(EXCLUDED.name, ''), vessels_live.name),
    ship_type = COALESCE(EXCLUDED.ship_type, vessels_live.ship_type),
    destination = COALESCE(NULLIF(EXCLUDED.destination, ''), vessels_live.destination),
    source = EXCLUDED.source,
    updated_at = NOW();
END;
$function$
;
