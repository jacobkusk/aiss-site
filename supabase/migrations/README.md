# supabase/migrations

Future DDL lives here as timestamped `.sql` files. The remote DB is the source
of truth today — the `functions-sql/` folder mirrors every RPC 1:1, but the
table/index/trigger/policy history is only in the remote migration history.

## Baseline

The project was migrated via the Supabase dashboard + MCP through
**2026-04-16**. The final baseline migration on the remote DB is:

```
20260416120818_pin_search_path_on_rpcs
```

Everything at or before that version defines "the baseline schema". A full
`pg_dump --schema-only` dump is a separate ops task — requires the Supabase
CLI linked against the project locally:

```bash
# one-time setup
supabase link --project-ref grugesypzsebqcxcdseu

# pull the baseline
supabase db dump --schema public --file supabase/migrations/0001_baseline.sql
```

That produces a single self-contained file describing every table, index,
constraint, trigger, partition, policy, and RLS setting on the remote DB.
Until that's run, the remote history (queried via
`supabase_migrations.schema_migrations`) is the definitive record.

## Going forward

New DB changes go here as `YYYYMMDDHHMMSS_<snake_case_name>.sql`:

- Table / index / constraint / policy changes → write the migration here,
  apply via `supabase db push` or `mcp__supabase__apply_migration`.
- RPC body changes → also update the matching file in `../functions-sql/`
  so a from-scratch rebuild of the DB from the CLI dump + migrations stays
  consistent with runtime.
- After every schema change run the MANDATORY RLS checklist in
  `../../CLAUDE.md`.

## Why not just dump everything now

`pg_dump` is not available in the Cowork sandbox this project is currently
being operated from. The baseline pointer above lets us commit a clean
migration folder today; the dump is a ≤ 5-minute task next time someone
runs a local shell with the Supabase CLI installed.
