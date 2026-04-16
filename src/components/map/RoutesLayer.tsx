"use client";

import { useEffect, useRef } from "react";
import { useMap } from "./MapContext";
import { supabase } from "@/lib/supabase";

const SOURCE = "routes-dp";
const LAYER  = "routes-dp-line";

const MIN_ZOOM = 5.0;  // hent data fra dette zoom
const MAX_ZOOM = 10.0; // over dette zoom: ingen fetch, linjer usynlige

interface Props {
  /** MMSI watchlist — hvis sat, vis kun disse. Undefined = vis alle */
  watchlist?: number[];
  visible?: boolean;
}

export default function RoutesLayer({ watchlist, visible = true }: Props) {
  const map = useMap();
  const fetchRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const initializedRef = useRef(false);

  // Init source + layer
  useEffect(() => {
    if (!map || initializedRef.current) return;
    initializedRef.current = true;

    const empty = { type: "FeatureCollection" as const, features: [] };
    map.addSource(SOURCE, { type: "geojson", data: empty });
    map.addLayer({
      id: LAYER,
      type: "line",
      source: SOURCE,
      paint: {
        "line-color": "#2ba8c8",
        "line-width": ["interpolate", ["linear"], ["zoom"], 6.5, 0.8, 10, 1.2],
        "line-opacity": ["interpolate", ["linear"], ["zoom"],
          MIN_ZOOM, 0,    // usynlig ved MIN_ZOOM
          6.5,      0.3,  // fade ind
          8.5,      0.4,  // fuldt synlig
          9.5,      0.2,  // begynder at fade
          MAX_ZOOM, 0,    // helt væk
        ],
      },
      layout: { visibility: visible ? "visible" : "none" },
    });

    return () => {
      try {
        if (map.getLayer(LAYER))  map.removeLayer(LAYER);
        if (map.getSource(SOURCE)) map.removeSource(SOURCE);
      } catch { /* map destroyed */ }
      initializedRef.current = false;
    };
  }, [map]);

  // Toggle visibility
  useEffect(() => {
    if (!map || !map.getLayer(LAYER)) return;
    map.setLayoutProperty(LAYER, "visibility", visible ? "visible" : "none");
  }, [map, visible]);

  // Fetch on map move/zoom — debounced
  useEffect(() => {
    if (!map) return;

    const fetch = () => {
      clearTimeout(fetchRef.current);
      fetchRef.current = setTimeout(async () => {
        if (!visible) return;
        const z = map.getZoom();
        if (z < MIN_ZOOM || z > MAX_ZOOM) {
          (map.getSource(SOURCE) as maplibregl.GeoJSONSource)?.setData(
            { type: "FeatureCollection", features: [] }
          );
          return;
        }

        const bounds = map.getBounds();
        const { data, error } = await supabase.rpc("get_routes_in_bbox", {
          min_lon: bounds.getWest(),
          min_lat: bounds.getSouth(),
          max_lon: bounds.getEast(),
          max_lat: bounds.getNorth(),
        });
        if (error || !data) return;

        // Parse defensively (Supabase may wrap jsonb)
        let geojson: any = data;
        if (typeof geojson === "string") try { geojson = JSON.parse(geojson); } catch { return; }

        // Watchlist filter
        if (watchlist && watchlist.length > 0) {
          geojson = {
            ...geojson,
            features: geojson.features?.filter((f: any) =>
              watchlist.includes(f.properties?.mmsi)
            ) ?? [],
          };
        }

        (map.getSource(SOURCE) as maplibregl.GeoJSONSource)?.setData(geojson);
      }, 400); // 400ms debounce
    };

    map.on("moveend", fetch);
    map.on("zoomend", fetch);
    map.on("zoom", fetch);    // ryd data under zoom-animation
    fetch(); // initial fetch

    return () => {
      map.off("moveend", fetch);
      map.off("zoomend", fetch);
      map.off("zoom", fetch);
      clearTimeout(fetchRef.current);
    };
  }, [map, visible, watchlist]);

  return null;
}
