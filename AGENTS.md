<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Projektoverblik — læs dette før du begynder

Dette er ét af tre projekter der udvikles sideløbende:
- **aiss.network** (dette repo) — port 3000 — Supabase: grugesypzsebqcxcdseu
- **vier.blue** (`waveo.blue`-mappen) — port 3002 — Supabase: orkydlnqeurgcwaljnte
- **waveo.blue** (ikke bygget endnu) — port 3001

Alle arkitektur- og implementeringsbeslutninger dokumenteres i `PROJECTS.md` (dette repo).
Ingen beslutning tages i ét projekt uden at tjekke om det påvirker de andre.

**Tech stack er identisk på tværs af alle tre:**
Next.js 16, TypeScript, Supabase, Tailwind. vier og waveo henter AIS-data via aiss.network API — de har ingen egen AIS-pipeline.

**Porte er låste:** 3000 = aiss, 3001 = waveo, 3002 = vier. Ændr aldrig dette.
