# Edge Function Runbook — Kilde til Sandhed

> Oprettet: 2026-04-16 (efter 500-storm i `ingest-positions`)
> Når en Supabase edge function returnerer 500 og logs-panelet ikke fortæller hvorfor, følg rækkefølgen herunder.

---

## 1. Fem regler du aldrig bryder

Disse er også i `CLAUDE.md` — her med fuld kontekst.

### 1.1 Aldrig `.catch()` / `.finally()` på supabase-js chains

`supabase.rpc()`, `.from().select()`, `.storage.from().upload()` returnerer en `PostgrestBuilder` (også kaldet `PostgrestFilterBuilder`, `PostgrestTransformBuilder` afhængig af trin). Den implementerer `PromiseLike` — den er `await`-bar — men den er IKKE et `Promise`. Derfor findes `.catch()` og `.finally()` ikke på den. TypeScript fanger det ikke fordi returtypen eksponerer `then()` korrekt.

Fejlen ser sådan ud i runtime:

```
TypeError: supabase.rpc(...).catch is not a function
```

Korrekt mønster:

```ts
// Idempotent kald man gerne må fejle på:
try { await supabase.rpc("ensure_partition", { p_date: today }) }
catch { /* idempotent — ignoreret med vilje */ }

// Almindelig fejlhåndtering via destructureret error:
const { data, error } = await supabase.rpc("foo", { … })
if (error) {
  console.error("foo RPC failed:", error.message)
  return Response.json({ error: error.message }, { status: 500 })
}
```

### 1.2 Top-level try/catch i `Deno.serve`

Hver edge function skal have denne wrapper:

```ts
Deno.serve(async (req: Request) => {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as Error
    console.error("[fn-name] FATAL:", err.message, err.stack)
    return new Response(JSON.stringify({
      error: "unhandled",
      message: err.message,
      stack: err.stack?.split("\n").slice(0, 8),
    }), { status: 500, headers: { "Content-Type": "application/json" } })
  }
})
```

Begrundelse: Supabase's Edge Function logs-panel viser kun request-summaries (`POST | 500 | … | 197ms`). `console.error` output dukker ikke op der. Uden top-level catch og body-propagering er vi blinde udefra.

### 1.3 Per-reason counters fra dag ét

Enhver validator skal tælle reasons separat og persistere dem:

```ts
type RejectReason = "mmsi_invalid" | "invalid_coords" | "out_of_bounds" | …
const reasons: Record<RejectReason, number> = { mmsi_invalid: 0, … }
```

Send `reasons` videre til RPC'en, som merger med sine egne reasons i `ingest_stats.reject_reasons` (jsonb). En samlet `rejected`-procent er ubrugelig til diagnostik — den oprindelige "~33 % rejected"-symptom viste sig at være tre blandede årsager: base-station MMSIs, intra-batch dubletter, og lejlighedsvise out-of-bounds.

### 1.4 `pg_net.http_post` er diagnostik-kanalen

Når sandboxen ikke kan curle udefra (proxy 403) og logs ikke fortæller stacken, fyr requesten fra Postgres:

```sql
SELECT net.http_post(
  url := 'https://<project>.supabase.co/functions/v1/<fn-name>',
  headers := jsonb_build_object('Content-Type','application/json'),
  body := jsonb_build_object('positions', jsonb_build_array(…))
) AS request_id;

-- vent 2-3 sekunder
SELECT pg_sleep(3);
SELECT id, status_code, content::text, error_msg
FROM net._http_response
WHERE id = <request_id>;
```

Det var det eneste der afslørede `TypeError: supabase.rpc(...).catch is not a function` — fordi regel 1.2's wrapper skrev stacken i body, og pg_net læste body.

### 1.5 Smoke test efter deploy

Før man siger "det er fixet":
1. Deploy.
2. `pg_net.http_post` med et realistisk payload (inkluder kendte edge cases — base station MMSI, duplikat, out-of-bounds).
3. Læs `status_code` + `content`.
4. Verificér at `ingest_stats` fik en ny række med korrekte `reject_reasons`.

Ikke bare stare på logs-panelet og håbe.

---

## 2. Debugging-sekvens når en edge function 500'er

Følg i rækkefølge. Stop så snart årsagen er fundet.

### Trin 1 — Bekræft omfanget

```sql
SELECT
  count(*)                                            AS total,
  sum(CASE WHEN status_code = 500 THEN 1 ELSE 0 END)  AS five_hundreds,
  sum(CASE WHEN status_code = 200 THEN 1 ELSE 0 END)  AS two_hundreds,
  min(to_timestamp(timestamp/1000000))                AS earliest,
  max(to_timestamp(timestamp/1000000))                AS latest
FROM edge_logs  -- eller brug mcp__supabase__get_logs service=edge-function
WHERE function_slug = '<fn-name>'
  AND timestamp > (extract(epoch from now() - interval '1 hour') * 1000000)::bigint;
```

Er det 100 % 500, 50 %, eller sporadisk? Svaret ændrer hypotesen.

### Trin 2 — Tjek om body indeholder en stack

Hvis edge function har regel 1.2's wrapper, skulle stacken være i body:

```sql
-- Fyr en kendt-god request
SELECT net.http_post(
  url := 'https://<project>.supabase.co/functions/v1/<fn-name>',
  headers := jsonb_build_object('Content-Type','application/json'),
  body := '<minimal gyldigt payload>'::jsonb
) AS rid;
SELECT pg_sleep(3);
SELECT status_code, content::text FROM net._http_response WHERE id = <rid>;
```

Hvis body er `{"error":"unhandled","message":"…","stack":[…]}` → hop til trin 5.
Hvis body er tomt eller 200 → funktionen er sund, problemet er payload-specifikt. Prøv et realistisk payload næste gang.

### Trin 3 — Funktionen mangler wrapper — deploy den først

Hvis body er tom / ikke-JSON: funktionen har ingen top-level catch. Tilføj regel 1.2-wrapper, bump versionsnummer i header-kommentaren, deploy. Gå tilbage til trin 2.

### Trin 4 — Tjek Postgres logs for RPC-fejl

Hvis funktionen når sin RPC og den fejler:

```
mcp__supabase__get_logs service=postgres
```

Kig efter `ERROR` med timestamps i samme vindue som 500'erne. Typiske mønstre:
- `function foo(…) does not exist` → PostgREST schema cache er stale. Kør `NOTIFY pgrst, 'reload schema'`.
- `column "foo" of relation "bar" does not exist` → migration er ikke kørt i det miljø du tror.
- `permission denied for table foo` → RLS eller GRANT mangler.

### Trin 5 — Aflæs stacken fra body

Body'en fra trin 2 giver dig fil + linjenummer. Læs koden der. De almindeligste findings:
- `.catch is not a function` → regel 1.1.
- `Cannot read properties of undefined (reading 'X')` → destructure på fejlet RPC return uden error-check.
- `Invalid URL` / `fetch failed` → env var mangler i edge function env.

### Trin 6 — Fix, bump version i header, deploy, smoke test

Regel 1.5. Ikke bare stare på logs.

---

## 3. Den aktuelle ingest-positions postmortem (2026-04-16)

### Symptom
PI rapporterede `~33 % rejected` i sine logs. `ingest_stats.rejected` viste 0 %. Noget i midten af kæden droppede rækker uden at logge det.

### Root cause (to lag)

**Lag 1 — observability gap:** Edge function v1-v4 talte kun total `rejected`. Der var ingen per-reason breakdown hverken i response eller i `ingest_stats`. Vi kunne ikke se at de rejections mest var base-station MMSIs (`002190047` som pyais strippede til `2190047`) plus intra-batch dubletter.

**Lag 2 — `.catch` TypeError:** Da jeg i v5/v6 tilføjede `p_edge_rejected` / `p_edge_reasons` til RPC-kaldet, rørte jeg også `ensure_partition`-kaldene og skrev `.catch(() => {})` på dem. Det crashede hver eneste request med `TypeError: supabase.rpc(...).catch is not a function`. PI så 500'er. En enkelt 200 slap igennem (den tidlige exit-sti når alle rows Edge-forkastes — den rammer aldrig `ensure_partition`).

### Fix (v7)

```diff
- await supabase.rpc("ensure_partition", { p_date: today.toISOString().slice(0, 10) }).catch(() => {})
- await supabase.rpc("ensure_partition", { p_date: tomorrow.toISOString().slice(0, 10) }).catch(() => {})
+ try { await supabase.rpc("ensure_partition", { p_date: today.toISOString().slice(0, 10) }) } catch { /* idempotent */ }
+ try { await supabase.rpc("ensure_partition", { p_date: tomorrow.toISOString().slice(0, 10) }) } catch { /* idempotent */ }
```

### Verifikation

Efter deploy, pg_net smoke test returnerede 200 med korrekte breakdown:
```json
{
  "accepted": 2,
  "rejected": 1,
  "edge_rejected": 1,
  "rpc_rejected": 0,
  "reject_reasons": { "duplicate_within_batch": 1, … },
  "source": "pi4_rtlsdr"
}
```
PI'en gik fra 100 % 500'er til 100 % 200'er inden for 30 sekunder.

### Hvorfor det tog tid
- Logs-panelet viste kun summaries — ikke stacken.
- Jeg kunne ikke curle udefra pga. sandbox-proxy 403.
- Jeg deploy'ede v5 og så en enkelt heldig 200 — troede det var "schema cache warmup" og var færdig. Det var to forskellige kodestier.
- Først da jeg tilføjede top-level catch → body-propagering (v6) og fyrede pg_net (i stedet for curl) kunne jeg se den egentlige `TypeError`.

### Hvad ville have forhindret det
- Regel 1.2 (top-level catch) havde været i edge function fra starten → stacken havde været tilgængelig med det samme.
- Regel 1.5 (smoke test med pg_net efter deploy) havde fanget det 5 sekunder efter v5 deploy, ikke 40 minutter senere.
- En Deno test der mocker `supabase.rpc` og tjekker at alle kald er `try { await … } catch` → havde fanget det pre-deploy.

---

## 4. Næste forbedringer

Ikke blokkere for andet arbejde, men værd at lave når man alligevel er i koden:

1. **Påfør regel 1.2 på alle edge functions** — `collector`, `tracks`, `merkle`, `ingest-ais`, `health`, `monitor`, `land-layer` skal alle have top-level catch. Pt. er det kun `ingest-positions` (v7) der har det.
2. **PI-siden læser ikke `rpc_reject_reasons`** — den logger bare `sendt/ok/rej` tællere. Opdater `scripts/pi/ais_to_supabase.py` så den læser `response.json()["reject_reasons"]` og logger pr. reason i journald. Så er rejection breakdown synlig både lokalt og i DB.
3. **Deno test-harness** — minimal test der mocker `createClient` og kører en happy-path batch igennem. Kører i pre-deploy hook.
