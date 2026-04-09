#!/usr/bin/env python3
"""
ais_to_supabase.py — Pi AIS collector
Sender AIS-positioner til aiss ingest-ais Edge Function.
Kører som systemd service på Raspberry Pi.
"""

import subprocess
import threading
import queue
import time
import json
import requests
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ais")

# ---------------------------------------------------------------------------
# Konfiguration
# ---------------------------------------------------------------------------

SUPABASE_URL     = "https://grugesypzsebqcxcdseu.supabase.co"
SUPABASE_KEY     = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdydWdlc3lwenNlYnFjeGNkc2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDY3MDYxNjAsImV4cCI6MjAyMjI4MjE2MH0.placeholder"

# Edge Function endpoint (ny pipeline)
EDGE_FUNCTION_URL = f"{SUPABASE_URL}/functions/v1/ingest-ais"

# Gammel RPC endpoint (dual-write fallback, sæt False når valideret)
DUAL_WRITE       = True
RPC_URL          = f"{SUPABASE_URL}/rest/v1/rpc/batch_upsert_positions"

FLUSH_INTERVAL   = 5      # sekunder mellem flushes
MAX_BUFFER       = 200    # max positioner i buffer

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

position_buffer: list[dict] = []
buffer_lock = threading.Lock()
stats = {"sent": 0, "accepted": 0, "rejected": 0, "errors": 0}

# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

SESSION = requests.Session()
SESSION.headers.update({
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
})

def post_edge_function(positions: list[dict]) -> tuple[int, int]:
    """Send til ingest-ais Edge Function. Returnerer (accepted, rejected)."""
    try:
        resp = SESSION.post(
            EDGE_FUNCTION_URL,
            json={"positions": positions},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("accepted", 0), data.get("rejected", 0)
    except requests.exceptions.RequestException as e:
        log.error(f"[edge] HTTP fejl: {e}")
        return 0, 0
    except Exception as e:
        log.error(f"[edge] Uventet fejl: {e}")
        return 0, 0


def post_rpc_legacy(positions: list[dict]) -> bool:
    """Dual-write til gamle tabeller via batch_upsert_positions RPC."""
    try:
        resp = SESSION.post(
            RPC_URL,
            json={"p_positions": positions},
            timeout=10,
        )
        resp.raise_for_status()
        return True
    except Exception as e:
        log.warning(f"[legacy] dual-write fejl: {e}")
        return False

# ---------------------------------------------------------------------------
# Flush
# ---------------------------------------------------------------------------

def flush():
    global position_buffer

    with buffer_lock:
        if not position_buffer:
            return
        batch = position_buffer[:]
        position_buffer = []

    stats["sent"] += len(batch)

    # Primær: Edge Function (ny pipeline)
    accepted, rejected = post_edge_function(batch)
    stats["accepted"] += accepted
    stats["rejected"] += rejected

    log.info(f"[new] {accepted} accepted, {rejected} rejected  |  total sent={stats['sent']}")

    # Dual-write til gamle tabeller (midlertidigt)
    if DUAL_WRITE:
        post_rpc_legacy(batch)

# ---------------------------------------------------------------------------
# Flush thread
# ---------------------------------------------------------------------------

def flush_loop():
    while True:
        time.sleep(FLUSH_INTERVAL)
        try:
            flush()
        except Exception as e:
            log.error(f"flush fejl: {e}")
            stats["errors"] += 1

# ---------------------------------------------------------------------------
# rtl_ais parser
# ---------------------------------------------------------------------------

def parse_ais_line(line: str) -> dict | None:
    """
    Parser rtl_ais JSON output.
    Typisk format: {"mmsi":219001234,"lat":55.676,"lon":12.568,...}
    """
    line = line.strip()
    if not line or not line.startswith("{"):
        return None
    try:
        data = json.loads(line)
        # Kræv minimum mmsi + koordinater
        if "mmsi" not in data and "MMSI" not in data:
            return None
        if "lat" not in data and "latitude" not in data and "Latitude" not in data:
            return None
        return data
    except json.JSONDecodeError:
        return None

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    log.info("=" * 50)
    log.info("aiss Pi collector starter")
    log.info(f"  endpoint: {EDGE_FUNCTION_URL}")
    log.info(f"  dual-write: {DUAL_WRITE}")
    log.info(f"  flush interval: {FLUSH_INTERVAL}s")
    log.info("=" * 50)

    # Start flush thread
    t = threading.Thread(target=flush_loop, daemon=True)
    t.start()

    # Start rtl_ais
    proc = subprocess.Popen(
        ["rtl_ais", "-n"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )

    log.info(f"rtl_ais PID: {proc.pid}")

    try:
        for raw_line in proc.stdout:
            position = parse_ais_line(raw_line)
            if position is None:
                continue

            mmsi = position.get("mmsi") or position.get("MMSI")
            lat  = position.get("lat") or position.get("latitude")

            with buffer_lock:
                position_buffer.append(position)
                buf_len = len(position_buffer)

            log.debug(f"  MMSI={mmsi} lat={lat}")

            # Flush hvis buffer er fyldt
            if buf_len >= MAX_BUFFER:
                flush()

    except KeyboardInterrupt:
        log.info("Afbrudt — flush resterende...")
        flush()
    finally:
        proc.terminate()
        log.info(f"Slut. Sendt={stats['sent']} accepted={stats['accepted']} rejected={stats['rejected']}")


if __name__ == "__main__":
    main()
