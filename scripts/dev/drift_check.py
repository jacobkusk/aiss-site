#!/usr/bin/env python3
"""Compare every deployed Postgres function in the `public` schema against
its source file in `supabase/functions-sql/`.

The source folder is the hand-authored record. The deployed function is
the one the app actually calls. Any drift between them means our source
tree is lying about what's running in production — and "apply this file
to a rebuilt DB and get the same behaviour back" stops being true.

Usage
-----

1. Dump the deployed definitions. From the Supabase MCP console (or any
   psql session on `grugesypzsebqcxcdseu`) run:

       SELECT
         p.proname AS name,
         pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_functiondef(p.oid) AS def
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prokind = 'f'
       ORDER BY p.proname;

   Save the rows as a JSON array: `[{"name": "...", "args": "...", "def": "..."}, ...]`

2. Feed that JSON to this script:

       python scripts/dev/drift_check.py < deployed_functions.json

Output
------

    OK:     <n>       deployed defs that match a source block verbatim (modulo whitespace + comments)
    DRIFT:  <n>       mismatches, one line per drifted deployed function:
      [SIG_DRIFT]    signature (args/return type) differs from every source block
      [BODY_DRIFT]   signature matches a source block but body differs
      [NO_DEPLOYED_FN]    source file exists but nothing is deployed under that name
      [DEPLOYED_NO_SOURCE] deployed function has no source file tracking it

Normalisation
-------------

Before comparing, both sides have SQL line comments (`-- ...`) stripped,
whitespace collapsed, and punctuation spacing (`,`, `(`, `)`) normalised.
That lets us ignore cosmetic differences between `pg_get_functiondef`'s
canonical formatting and the hand-authored source files.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = REPO_ROOT / "supabase" / "functions-sql"


def strip_line_comments(s: str) -> str:
    # SQL line comments. We don't have `--` inside any string literal in this codebase.
    return re.sub(r"--[^\n]*", "", s)


def norm(s: str) -> str:
    s = strip_line_comments(s)
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\s*([(),])\s*", r"\1", s)
    return s.strip()


_FN_BLOCK = re.compile(
    r"(CREATE OR REPLACE FUNCTION.*?\$function\$.*?\$function\$)",
    re.DOTALL | re.IGNORECASE,
)
_SIG_RE = re.compile(
    r"(CREATE OR REPLACE FUNCTION.*?)AS \$function\$",
    re.DOTALL | re.IGNORECASE,
)


def extract_fn_blocks(sql: str) -> list[str]:
    return list(_FN_BLOCK.findall(sql))


def signature(block: str) -> str:
    m = _SIG_RE.search(block)
    return norm(m.group(1)) if m else "?"


def main() -> int:
    try:
        rows = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"stdin is not valid JSON: {e}", file=sys.stderr)
        return 2

    by_name: dict[str, list[dict]] = {}
    for r in rows:
        by_name.setdefault(r["name"], []).append(r)

    src_names = {p.stem for p in SRC_DIR.glob("*.sql")}
    drift: list[tuple[str, str, str]] = []
    ok = 0
    unreadable: list[str] = []

    for src_file in sorted(SRC_DIR.glob("*.sql")):
        name = src_file.stem
        deployed = by_name.get(name)
        if not deployed:
            drift.append((name, "-", "NO_DEPLOYED_FN"))
            continue
        src_blocks = extract_fn_blocks(src_file.read_text())
        if not src_blocks:
            unreadable.append(name)
            continue
        src_norms = {norm(b) for b in src_blocks}
        src_sigs = [signature(b) for b in src_blocks]
        for d in deployed:
            dep_norm = norm(d["def"])
            if dep_norm in src_norms:
                ok += 1
                continue
            dep_sig = signature(d["def"])
            kind = "BODY_DRIFT" if dep_sig in src_sigs else "SIG_DRIFT"
            drift.append((name, d.get("args") or "<noargs>", kind))

    for name, overloads in by_name.items():
        if name not in src_names:
            for d in overloads:
                drift.append((name, d.get("args") or "<noargs>", "DEPLOYED_NO_SOURCE"))

    print(f"OK:     {ok}")
    print(f"DRIFT:  {len(drift)}")
    for d in drift:
        print(f"  [{d[2]}] {d[0]}({d[1]})")
    if unreadable:
        print(f"\nUNREADABLE SRC: {unreadable}", file=sys.stderr)

    return 1 if drift else 0


if __name__ == "__main__":
    raise SystemExit(main())
