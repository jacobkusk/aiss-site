"use client";

import { useEffect } from "react";
import { useMap } from "./MapContext";
import { supabase } from "@/lib/supabase";
import maplibregl from "maplibre-gl";

const OVERLAYS = {
  seamarks: {
    source: {
      type: "raster" as const,
      tiles: ["https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenSeaMap",
    },
    paint: { "raster-opacity": 0.85 },
  },
  eez: {
    source: {
      type: "raster" as const,
      tiles: [
        "https://geo.vliz.be/geoserver/MarineRegions/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap" +
        "&LAYERS=eez&STYLES=&FORMAT=image/png&TRANSPARENT=true" +
        "&WIDTH=256&HEIGHT=256&SRS=EPSG:3857&BBOX={bbox-epsg-3857}",
      ],
      tileSize: 256,
      attribution: "© MarineRegions",
    },
    paint: { "raster-opacity": 0.6 },
  },
};

interface Props {
  showSeamarks?: boolean;
  showEEZ?: boolean;
  showLand?: boolean; // Midlertidig — vis kystlinje-polygon til kvalitetstjek
}

export default function MaritimeOverlays({ showSeamarks = false, showEEZ = false, showLand = false }: Props) {
  const map = useMap();

  // Land polygon overlay — midlertidig kvalitetstjek
  useEffect(() => {
    if (!map) return;
    const src = "ne-land-debug";
    const lyr = "ne-land-debug-fill";

    if (showLand && !map.getSource(src)) {
      map.addSource(src, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: lyr, type: "fill", source: src,
        paint: { "fill-color": "#ff0000", "fill-opacity": 0.25 },
      });
      // Hent data
      supabase.rpc("get_land_geojson").then(({ data }) => {
        if (data) (map.getSource(src) as maplibregl.GeoJSONSource)?.setData(data as any);
      });
    }
    if (map.getLayer(lyr)) {
      map.setLayoutProperty(lyr, "visibility", showLand ? "visible" : "none");
    }
  }, [map, showLand]);

  useEffect(() => {
    if (!map) return;

    const toggle = (key: keyof typeof OVERLAYS, visible: boolean) => {
      const src = `maritime-${key}`;
      const lyr = `maritime-${key}-layer`;

      if (!map.getSource(src)) {
        map.addSource(src, OVERLAYS[key].source);
        map.addLayer({
          id: lyr, type: "raster", source: src,
          paint: OVERLAYS[key].paint,
          layout: { visibility: "none" },
        });
      }
      if (map.getLayer(lyr)) {
        map.setLayoutProperty(lyr, "visibility", visible ? "visible" : "none");
      }
    };

    toggle("seamarks", showSeamarks);
    toggle("eez", showEEZ);
  }, [map, showSeamarks, showEEZ]);

  return null;
}

// Eksportér hook til land overlay test
export { };
