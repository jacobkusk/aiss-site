export interface Vessel {
  id?: string;
  mmsi: number;
  ship_name: string | null;
  lat: number;
  lon: number;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  speed: number | null;
  ship_type?: number | null;
  destination?: string | null;
  source?: string;
  image_url?: string | null;
  user_id?: string | null;
  vessel_id?: string | null;
  vessel_prefix?: string | null;
  updated_at?: string;
  max_speed?: number | null;
  avg_speed_moving?: number | null;
}

export interface Route {
  mmsi: number;
  ship_name: string | null;
  distance_nm: number;
  avg_speed: number;
  geojson: GeoJSON.Geometry;
}

export interface Stats {
  vesselCount: number;
  routeCount: number;
  totalNm: number;
}
