# Pi Operations — Kilde til Sandhed

> Opdateret: 2026-04-13 (efter rebuild fra bunden)
> Alt om Pi'en samlet ét sted. Læs dette FØR du rører noget Pi-relateret.

---

## 1. Hardware

| Komponent | Detalje |
|-----------|---------|
| Board | Raspberry Pi 4 Model B |
| Hostname | `aiss` |
| OS | Raspberry Pi OS (Bookworm) |
| LAN IP | `192.168.0.143` |
| MAC | `e4:5f:01:27:9c:54` |
| SSH | `ssh pi@192.168.0.143` |
| SDR | Nooelec NESDR SMArt v5, SN: 70950465 |
| USB ID | `0bda:2838` (bruges til at tjekke om donglen er til stede) |
| Antenne | AIS-antenne tilsluttet via koaksialkabel til SDR-donglen |

---

## 2. Signalvej: Antenne → Prik på Skærm

```
┌─────────────┐     VHF 161.975/162.025 MHz
│  AIS-antenne │─────────────────────────┐
└─────────────┘                          │
                                         ▼
┌─────────────────────────────────────────────────┐
│  Raspberry Pi 4                                  │
│                                                  │
│  ┌──────────────────────┐                        │
│  │  ais-catcher.service  │  ← SDR-decoder        │
│  │  AIS-catcher v0.66    │    (5-10x bedre        │
│  │  gain: tuner 40.2     │     end rtl_ais)       │
│  │  rtlagc: off          │                        │
│  └──────────┬───────────┘                        │
│             │ UDP 127.0.0.1:10110 (NMEA)          │
│             ▼                                    │
│  ┌──────────────────────┐                        │
│  │  ais-ingest.service   │  ← Python sender       │
│  │  ais_to_supabase.py   │    Lytter på UDP       │
│  │  - decode (pyais)     │    Buffer 5s           │
│  │  - flush → Edge Fn    │    HTTPS POST          │
│  └──────────┬───────────┘                        │
└─────────────┼───────────────────────────────────┘
              │ HTTPS POST
              ▼
┌───────────────────────────────────────────────────┐
│  Supabase (grugesypzsebqcxcdseu, eu-west-1)        │
│                                                    │
│  Edge Function: ingest-positions                   │
│    ↓                                               │
│  positions_v2 (partitioneret per dag)              │
│  entity_last (sidst kendte position per skib)      │
│  ingest_stats (rate-tracking per kilde)            │
└────────────────────────┬──────────────────────────┘
                         │ Supabase REST API
                         ▼
┌───────────────────────────────────────────────────┐
│  aiss.network (Next.js på Vercel)                  │
│  MapLibre GL → render skibe som prikker            │
└───────────────────────────────────────────────────┘
```

**Latency (typisk):**
- Antenne → AIS-catcher: ~0ms
- AIS-catcher → Python (UDP): ~0ms
- Buffer i Python: max 5 sekunder
- Python → Supabase Edge Function: ~100-300ms

---

## 3. Services på Pi

### ais-catcher.service (SDR-DECODER)

```ini
# /etc/systemd/system/ais-catcher.service
[Unit]
Description=AIS-catcher SDR decoder
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/AIS-catcher -u 127.0.0.1 10110 -gr tuner 40.2 rtlagc off -X off
Restart=always
RestartSec=10
User=pi

[Install]
WantedBy=multi-user.target
```

**AIS-catcher flags:**
- `-u 127.0.0.1 10110` → send NMEA via UDP til port 10110
- `-gr tuner 40.2 rtlagc off` → gain 40.2, ingen auto-gain
- `-X off` → ingen JSON-metadata i output (kun ren NMEA)

**VIGTIGT:** AIS-catcher er den primære SDR-decoder. Den er 5-10x bedre end rtl_ais. Den MÅ ALDRIG slettes.

### ais-ingest.service (DATA-SENDER)

```ini
# /etc/systemd/system/ais-ingest.service
[Unit]
Description=aiss AIS collector
After=network-online.target ais-catcher.service
Wants=network-online.target
Requires=ais-catcher.service

[Service]
Type=simple
User=pi
ExecStart=/usr/bin/python3 /home/pi/ais_to_supabase.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**VIGTIGT:** Scriptet ligger på `/home/pi/ais_to_supabase.py` — IKKE inde i nogen projektmappe.

`ais_to_supabase.py` starter IKKE rtl_ais eller AIS-catcher. Den lytter kun på UDP port 10110 og sender data til Supabase. AIS-catcher håndterer SDR'en via sin egen service.

**Ingen WatchdogSec. Ingen restart.conf drop-in. Ingen aiss-watchdog.service.** Kun disse to services skal køre.

---

## 4. Kritiske Konfigurationer

### Supabase Credentials

```python
SUPABASE_URL = "https://grugesypzsebqcxcdseu.supabase.co"
EDGE_FUNCTION_URL = f"{SUPABASE_URL}/functions/v1/ingest-positions"
```

**Vigtigt:** endpoint er `ingest-positions` — IKKE `ingest-ais` (den returnerer 500).

### UDP Port

```
UDP_HOST = "127.0.0.1"
UDP_PORT = 10110
```

AIS-catcher sender hertil, ais_to_supabase.py lytter.

### Buffer Settings

```python
FLUSH_INTERVAL = 5   # sekunder mellem sends
MAX_BUFFER = 200     # force-flush ved 200 positioner
```

---

## 5. AIS-Catcher Health Check

### Tjek at AIS-catcher kører

```bash
sudo systemctl status ais-catcher --no-pager | head -15
```

Forventet output: `Active: active (running)`

### Tjek at AIS-catcher modtager signaler (live)

```bash
sudo journalctl -u ais-catcher -n 10 --no-pager
```

Forventet output: NMEA-sætninger som `!AIVDM,1,1,,B,...` — ÉN per skib per sekund.

Hvis du ser `!AIVDM` → AIS-catcher modtager og decoder korrekt.
Hvis du ser ingen linjer → SDR er ikke klar (USB-problem eller forkert gain).

### Tjek fuld format (alle skibstyper)

AIS-catcher decoder som standard alle AIS-beskedtyper (1-27). Verificer at den ser forskellige typer:

```bash
sudo journalctl -u ais-catcher --since "5 min ago" --no-pager | grep "MSG:" | awk -F'MSG: ' '{print $2}' | cut -d',' -f1 | sort | uniq -c | sort -rn
```

Forventet: MSG type 1, 3, 18 (positioner), evt. 4 (basisstationer), 5 (statiske data).

### Tjek beskedrate (skibe pr. minut)

```bash
sudo journalctl -u ais-catcher --since "1 min ago" --no-pager | grep -c "!AIVDM"
```

Normal: 5-30 beskeder/min afhængigt af tidspunkt og trafik.
Alarm: 0 beskeder i 2+ minutter → SDR-problem.

### Tjek gain-indstilling

```bash
sudo systemctl cat ais-catcher | grep ExecStart
```

Skal vise: `-gr tuner 40.2 rtlagc off`

### Komplet AIS-catcher check (én kommando)

```bash
echo "=== AIS-catcher service ===" && \
sudo systemctl is-active ais-catcher && \
echo "=== Seneste NMEA ===" && \
sudo journalctl -u ais-catcher -n 5 --no-pager && \
echo "=== Beskeder siste minut ===" && \
sudo journalctl -u ais-catcher --since "1 min ago" --no-pager | grep -c "!AIVDM" && \
echo "beskeder/min"
```

---

## 6. Overvågning (4 lag)

### Lag 1: Supabase monitor (live)

**URL:** http://localhost:3000/health (lokalt) eller aiss.network/health

Viser:
- **"Pi modtager lige nu"** — antal unikke skibe set de seneste 2 minutter
- Datakilder status (ONLINE/LANGSOM/NEDE)
- Positioner pr. dag (7 dage)

### Lag 2: Supabase health-check (database-side)

```sql
SELECT check_ingest_health();
-- Returnerer: {"status": "OK", "current_rate": 342, "baseline_rate": 319, ...}
```

- OK: rate ≥ 30% af 7-dages baseline
- DEGRADED: rate < 30%
- DEAD: rate = 0

### Lag 3: Scheduled Cowork-agent

Task `ingest-health-check` kører hver 2. time og rapporterer status.

### Lag 4: Pi self-healing (pi-repair.sh)

Kører hvert 5. minut:

| Check | Handling |
|-------|---------|
| ais-catcher nede? | systemctl restart ais-catcher |
| ais-ingest nede? | systemctl restart ais-ingest |
| USB dongle forsvundet? | Reset USB-bus |
| Disk > 90%? | Vacuum journalctl |
| CPU temp > 75°C? | Log advarsel |

---

## 7. Normal Drift — Forventede Tal

| Metrik | Normal | Alarm |
|--------|--------|-------|
| Positioner/time | 200-600 | < 100 |
| Unikke skibe/time | 10-30 | < 5 |
| Skibe synlige (2 min) | 3-15 | 0 |
| NMEA-beskeder/min | 5-30 | 0 |
| CPU temp | 45-60°C | > 75°C |
| Disk usage | 20-40% | > 90% |

**Sæsonvariation:** Færre skibe om natten og i weekender. Øresund er travlest 06-22.

---

## 8. Deploy kodeændringer til Pi

```bash
# Fra Mac:
scp /Users/jacobkusk/maritime/aiss/scripts/pi/ais_to_supabase.py \
    pi@192.168.0.143:/home/pi/ais_to_supabase.py

# Derefter på PI:
sudo systemctl restart ais-ingest && sleep 5 && sudo journalctl -u ais-ingest -n 10 --no-pager
```

**Aldrig bruge heredoc til store filer** — brug altid SCP.

**Scriptet ligger på `/home/pi/ais_to_supabase.py`** — ikke i aiss-site eller nogen undermappe.

---

## 9. Fejlfinding — Beslutningstre

```
Ingen/få skibe på kortet?
│
├─ Tjek health monitor: localhost:3000/health
│  └─ "Pi modtager lige nu" = 0?
│     ├─ Ja → Pi sender ikke data
│     │  ├─ SSH: ssh pi@192.168.0.143
│     │  │  ├─ systemctl status ais-catcher → kører den?
│     │  │  │  ├─ Nej → sudo systemctl start ais-catcher
│     │  │  │  └─ Ja men ingen !AIVDM i logs → USB-problem
│     │  │  │     └─ lsusb | grep 0bda:2838 → er donglen til stede?
│     │  │  │        ├─ Nej → tag USB ud og ind igen
│     │  │  │        └─ Ja → sudo systemctl restart ais-catcher
│     │  │  └─ systemctl status ais-ingest → kører den?
│     │  │     ├─ Nej → sudo systemctl start ais-ingest
│     │  │     └─ Ja → tjek journalctl -u ais-ingest (ser den "Ingen data i 10s"?)
│     │  └─ Kan ikke SSH → Pi er nede
│     │     └─ Vent på hardware watchdog reboot
│     └─ Nej, antal er normalt → problem er frontend/RLS
│        └─ Tjek browser console fejl
│        └─ SET ROLE anon; SELECT * FROM positions_v2 LIMIT 1;
```

---

## 10. Kendte Problemer og Løsninger

### 2026-04-10/13: 3-dages crash-loop — root cause og løsning

**Problem:** `ais_to_supabase.py` indeholdt kode til at starte `rtl_ais` som subprocess. Men `ais-catcher.service` holdt allerede RTL-SDR donglen åben. Hvert forsøg på at starte rtl_ais crashede øjeblikkeligt med `usb_claim_interface error -6`. Derudover havde `ais-ingest.service` et `restart.conf` drop-in (`/etc/systemd/system/ais-ingest.service.d/restart.conf`) med `WatchdogSec=2min` — som dræbte Python-processen hvert 2. minut uanset hvad. En separat `aiss-watchdog.service` kørte også og interfererede.

**Symptomer:**
- `ais-ingest.service: Watchdog timeout (limit 2min)! Killing process with signal SIGABRT`
- Konstant genstart, aldrig stabil
- 3 dage med lappeløsninger oven på lappeløsninger

**Løsning:** Slet alt og start forfra. Tog 10 minutter.
1. Stop og disable `aiss-watchdog.service` og `ais-ingest.service`
2. `sudo killall -9 python3`
3. Slet `/etc/systemd/system/ais-ingest.service` og drop-in mappen
4. Slet det gamle script
5. Skriv nyt rent script uden rtl_ais, ny simpel service uden WatchdogSec

**Lektie:** Næste gang noget ikke virker efter 30 minutter fejlfinding — slet og genbyg. Beskriv hvad systemet *skal* gøre, ikke hvad der er galt.

### 2026-04-12/13: AIS-catcher slettet ved fejl
**Problem:** En Claude-session slettede AIS-catcher (`rm /usr/local/bin/AIS-catcher`) da den fejlagtigt troede det var problemet.
**Konsekvens:** 90% signaltab i ~24 timer, kun 4 skibe i stedet for 30+.
**Fix:** Geninstalleret AIS-catcher v0.66 fra source, oprettet ais-catcher.service.
**Prævention:** AIS-catcher MÅ ALDRIG slettes. Den er 5-10x bedre end rtl_ais.

### 2026-04-12: Zombie-processer låser SDR
**Problem:** Crashet rtl_ais efterlod zombie der holdt USB åben → `usb_claim_interface error -6`.
**Fix:** `sudo pkill -9 rtl_ais && sudo systemctl restart ais-catcher`
**Prævention:** rtl_ais bruges ikke længere. AIS-catcher har bedre crash-recovery.

### 2026-04-12/13: Forkert Edge Function endpoint
**Problem:** ais_to_supabase.py sendte til `ingest-ais` som returnerede 500.
**Fix:** Ændret til `ingest-positions` (den fungerende endpoint).

---

## 11. Recovery-matrix

| Fejl | Hvem fikser | Tid | Eskalering |
|------|------------|-----|------------|
| ais-catcher crasher | systemd (Restart=always) | 10 sek | |
| ais-ingest crasher | systemd (Restart=always) | 10 sek | |
| USB dongle forsvinder | pi-repair.sh (USB reset) | 5 min | |
| Ingen NMEA data | ais-ingest logger "Ingen data i 10s" | Øjeblik | Tjek ais-catcher |
| Total system freeze | Hardware watchdog (reboot) | 15 sek | |
| Pi helt nede | Scheduled task opdager det | 2 timer | Jac tjekker fysisk |
| Ingest-rate lav | check_ingest_health() via Cowork | 2 timer | Se fejlfinding |

---

## 12. Regler for Claude

1. **Læs dette dokument FØR du rører Pi-relateret kode.**
2. **AIS-catcher MÅ ALDRIG slettes.** Den er den primære decoder.
3. **rtl_ais bruges ikke.** Installer det ikke, start det ikke, tilføj det ikke til scripts.
4. **Deploy via SCP** fra Mac → Pi. Aldrig heredoc til store filer.
5. **Endpoint er `ingest-positions`**, ikke `ingest-ais`.
6. **Gain er `tuner 40.2` i ais-catcher.service** — ændr ikke uden test.
7. **Tjek `check_ingest_health()` efter alle ændringer.**
8. **Opdater dette dokument** når noget ændres.
9. **Ingen WatchdogSec, ingen restart.conf drop-in, ingen aiss-watchdog.service.**
10. **Scriptet ligger på `/home/pi/ais_to_supabase.py`** — ikke i nogen projektmappe.
11. **Hvis noget ikke virker efter 30 minutter: SLET OG GENBYG.** Lappeløsninger ophober sig.
