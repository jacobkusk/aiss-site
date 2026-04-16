# Player Adapter

Interface: se `/src/core/interfaces/index.ts`

Implementation: **MapLibre GL JS** (eneste tilladte kortbibliotek — se `CLAUDE.md`).

- Globe-projektion via `projection: 'globe'` + flat fallback
- Persistent track som `MultiLineStringM` fra `strings`-tabellen
- Live dot fra `entity_last`, clustering ved lav zoom for performance
- Z-akse ikke relevant for skibstrafik — havoverflade er 2D med tid som fjerde dimension

Fravalgt: CesiumJS, Deck.gl, Three.js — CLAUDE.md forbyder dem eksplicit. Z-akse-argumentet holdt ikke: `positions_v2` gemmer ingen højde/dybde, og "fly/drone/undervand"-lag er ikke på roadmappet.

Realiseret i `src/components/map/*` — ikke kun et adapter-skelet.
