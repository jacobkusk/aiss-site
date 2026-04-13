# aiss-site

Landing page + API docs for aiss.network — the open maritime data protocol.

## Stack

- Next.js 14+ (App Router, TypeScript)
- Tailwind CSS
- MapLibre GL JS (globe + flat map, NO other map lib)
- Supabase client for public reads
- Deployed on Vercel

## Supabase

- Project: `grugesypzsebqcxcdseu` (eu-west-1)
- This is the aiss.network database (separate from vier.blue)
- PostGIS enabled
- Core tables: vessels, ais_positions, ais_vessel_routes, stations, api_keys
- Waveo schema: organisations, geofences, cameras, events
- 15,000+ seeded vessel routes, 11 triggers on AIS insert
- Edge Function: `ais-collector` (verify_jwt: false)

## File Structure

```
aiss-site/
├── src/
│   ├── app/
│   │   ├── layout.tsx          # Dark theme, fonts
│   │   ├── page.tsx            # Landing page
│   │   └── globals.css         # CSS variables
│   ├── components/
│   │   ├── MapView.tsx         # MapLibre globe+map
│   │   ├── LeftPanel.tsx       # Panel container
│   │   ├── StatsBar.tsx        # Vessel/route/nm counters
│   │   ├── SearchInput.tsx     # Vessel search
│   │   ├── TimeMachine.tsx     # Date slider LIVE/HISTORICAL
│   │   ├── VesselList.tsx      # Scrollable vessel list
│   │   ├── VesselPopup.tsx     # Selected vessel detail
│   │   ├── GlobeMapToggle.tsx  # Globe/Map switch
│   │   └── Logo.tsx            # AISs branding
│   └── lib/
│       ├── supabase.ts         # Supabase client
│       ├── types.ts            # TypeScript interfaces
│       └── utils.ts            # MMSI country codes, formatting
├── public/fonts/               # JetBrains Mono
└── .env.local                  # NEXT_PUBLIC_SUPABASE_URL + ANON_KEY
```

## Design Rules

- Dark theme: space-dark background (#060D1A), NOT white
- Font: JetBrains Mono for data, system sans for UI
- Globe uses MapLibre `projection: 'globe'`
- Aqua (#2BA8C8) for tracked vessels, white for others
- No auth required — public site, no login
- Mobile: left panel collapses to bottom sheet
- Performance: 15k+ vessel dots — use MapLibre clustering at zoom < 5

## Brand

- Tagline: "Free to read. Trusted to write."
- Subtitle: "All maritime data. Every ship. Stored forever."
- Two-sided model: free reads, authenticated writes
- .aiss file format: `aiss:nav` (lightweight) + `aiss:full` (signed, Merkle-root)

## RLS Checklist (MANDATORY for every DB change)

Every migration, new table, new partition, or schema change MUST include RLS verification.
Run this after EVERY database change:

```sql
-- 1. Find tables with RLS enabled but NO policies (= broken for anon)
SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relrowsecurity = true
  AND n.nspname = 'public'
  AND NOT EXISTS (
    SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname
  )
ORDER BY c.relname;

-- 2. Test the actual RPC/query as anon
SET ROLE anon;
-- <run your query here>
RESET ROLE;
```

Rules:
- New tables that frontend reads → add `CREATE POLICY <t>_public_read ON <t> FOR SELECT TO public USING (true);`
- Partitions do NOT inherit policies from parent → add policy to EACH partition
- New RPC functions → test as `SET ROLE anon` before considering it done
- If something works in SQL console but returns empty from browser → it's RLS

## Do NOT

- Use any map library other than MapLibre
- Create new Supabase projects
- Add auth/login to the public site
- Change the dark theme to light
- Touch the ais-collector Edge Function unless specifically asked
- Install Cesium, deck.gl, or Three.js

## Deploy

```bash
npm run build
vercel --prod
```

Env vars in Vercel: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
Domain: aiss.network
