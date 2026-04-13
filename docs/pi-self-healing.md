# Raspberry Pi Self-Healing Setup — AISS

Komplet guide til 24/7 stabilitet for din Pi (AIS-ingest + RTL-SDR).
Du skal kun køre disse kommandoer **én gang** — derefter klarer Pi'en sig selv.

---

## Lag 1: Pi healer sig selv (kører lokalt på Pi)

### 1A. Hardware Watchdog — reboot ved total freeze

Pi'en har en hardware watchdog-chip (bcm2835_wdt) der automatisk rebooter hvis systemet hænger.

```bash
# SSH til Pi og kør:
ssh pi@100.125.161.64

# Aktiver hardware watchdog
sudo apt install -y watchdog
sudo systemctl enable watchdog

# Konfigurer watchdog
sudo tee /etc/watchdog.conf > /dev/null << 'WDCONF'
watchdog-device = /dev/watchdog
watchdog-timeout = 15
max-load-1 = 24
min-memory = 1
interface = eth0
temperature-sensor = /sys/class/thermal/thermal_zone0/temp
max-temperature = 80000
retry-timeout = 60
repair-binary = /usr/local/bin/pi-repair.sh
WDCONF

sudo systemctl restart watchdog
```

**Hvad det gør:** Hvis Pi'en fryser, rebooter den automatisk efter 15 sekunder. Ingen menneskelig indgriben.

### 1B. systemd auto-restart for ais-ingest

```bash
# Sikr at ais-ingest genstarter sig selv ved crash
sudo mkdir -p /etc/systemd/system/ais-ingest.service.d
sudo tee /etc/systemd/system/ais-ingest.service.d/restart.conf > /dev/null << 'SYSD'
[Service]
Restart=always
RestartSec=10
WatchdogSec=120
StartLimitIntervalSec=600
StartLimitBurst=5
SYSD

sudo systemctl daemon-reload
sudo systemctl restart ais-ingest
```

**Hvad det gør:** Hvis `ais-ingest` crasher, genstarter systemd den efter 10 sekunder. Max 5 genstarter på 10 min (så den ikke looper).

### 1C. Master repair-script (kører hvert 5. minut via cron)

```bash
sudo tee /usr/local/bin/pi-repair.sh > /dev/null << 'REPAIR'
#!/bin/bash
# Pi Self-Healing Script — kører hvert 5. minut
LOG="/var/log/pi-selfheal.log"
ALERT_FILE="/tmp/pi-alert-needed"
SUPABASE_ALERT_URL="https://grugesypzsebqcxcdseu.supabase.co/functions/v1/pi-alert"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

PROBLEMS=0

# --- Check 1: Er ais-ingest kørende? ---
if ! systemctl is-active --quiet ais-ingest; then
    log "WARN: ais-ingest er nede. Forsøger genstart..."
    sudo systemctl restart ais-ingest
    sleep 10
    if systemctl is-active --quiet ais-ingest; then
        log "OK: ais-ingest genstartet succesfuldt"
    else
        log "ERROR: ais-ingest kunne ikke genstarte"
        PROBLEMS=$((PROBLEMS+1))
    fi
fi

# --- Check 2: USB dongle tilgængelig? ---
if ! lsusb | grep -q "0bda:2838"; then
    log "WARN: RTL-SDR USB dongle ikke fundet. Forsøger USB reset..."
    # Reset USB bus
    for port in /sys/bus/usb/devices/usb*/authorized; do
        echo 0 | sudo tee "$port" > /dev/null
        sleep 1
        echo 1 | sudo tee "$port" > /dev/null
    done
    sleep 5
    if lsusb | grep -q "0bda:2838"; then
        log "OK: USB dongle genfundet efter reset"
        sudo systemctl restart ais-ingest
    else
        log "ERROR: USB dongle stadig ikke fundet"
        PROBLEMS=$((PROBLEMS+1))
    fi
fi

# --- Check 3: Zombie rtl_ais processer? ---
ZOMBIES=$(pgrep -c rtl_ais 2>/dev/null || echo 0)
if [ "$ZOMBIES" -gt 1 ]; then
    log "WARN: $ZOMBIES rtl_ais processer fundet. Dræber zombies..."
    sudo pkill -9 rtl_ais
    sleep 2
    sudo systemctl restart ais-ingest
    log "OK: Zombies dræbt, ais-ingest genstartet"
fi

# --- Check 4: Diskplads ---
DISK_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_PCT" -gt 90 ]; then
    log "WARN: Disk $DISK_PCT% fuld. Rydder op..."
    sudo journalctl --vacuum-size=50M
    sudo apt-get clean -y
    sudo rm -rf /tmp/* 2>/dev/null
    log "OK: Disk renset"
fi

# --- Check 5: Temperatur ---
TEMP=$(cat /sys/class/thermal/thermal_zone0/temp)
TEMP_C=$((TEMP/1000))
if [ "$TEMP_C" -gt 75 ]; then
    log "WARN: CPU temp er ${TEMP_C}°C — for høj!"
    PROBLEMS=$((PROBLEMS+1))
fi

# --- Check 6: RAM ---
MEM_FREE=$(free -m | awk '/^Mem:/{print $7}')
if [ "$MEM_FREE" -lt 50 ]; then
    log "WARN: Kun ${MEM_FREE}MB RAM ledig. Dropper caches..."
    sync && echo 3 | sudo tee /proc/sys/vm/drop_caches > /dev/null
    log "OK: Caches droppet"
fi

# --- Check 7: Netværk ---
if ! ping -c 1 -W 5 8.8.8.8 > /dev/null 2>&1; then
    log "WARN: Ingen internetforbindelse. Genstarter networking..."
    sudo systemctl restart networking
    sleep 10
    if ! ping -c 1 -W 5 8.8.8.8 > /dev/null 2>&1; then
        log "ERROR: Stadig ingen internet efter restart"
        PROBLEMS=$((PROBLEMS+1))
    else
        log "OK: Internet gendannet"
    fi
fi

# --- Check 8: Tailscale ---
if ! tailscale status > /dev/null 2>&1; then
    log "WARN: Tailscale er nede. Genstarter..."
    sudo systemctl restart tailscaled
    sleep 5
    sudo tailscale up --accept-routes
    log "OK: Tailscale genstartet"
fi

# --- Alert hvis der er uløste problemer ---
if [ "$PROBLEMS" -gt 0 ]; then
    # Send alert via Supabase Edge Function (kun én gang per time)
    if [ ! -f "$ALERT_FILE" ] || [ $(( $(date +%s) - $(stat -c %Y "$ALERT_FILE" 2>/dev/null || echo 0) )) -gt 3600 ]; then
        BODY=$(tail -20 "$LOG")
        curl -s -X POST "$SUPABASE_ALERT_URL" \
            -H "Content-Type: application/json" \
            -d "{\"problems\": $PROBLEMS, \"log\": \"$BODY\"}" || true
        touch "$ALERT_FILE"
        log "ALERT: Sendt til Supabase ($PROBLEMS uløste problemer)"
    fi
else
    rm -f "$ALERT_FILE"
    # Log OK status hvert 30. minut (ikke hvert 5. minut)
    MINUTE=$(date +%M)
    if [ "$MINUTE" -lt 5 ] || [ "$MINUTE" -ge 30 -a "$MINUTE" -lt 35 ]; then
        log "OK: Alle checks bestået. Temp: ${TEMP_C}°C, Disk: ${DISK_PCT}%, RAM: ${MEM_FREE}MB fri"
    fi
fi
REPAIR

sudo chmod +x /usr/local/bin/pi-repair.sh
```

**Installer cron-job:**

```bash
(crontab -l 2>/dev/null; echo "*/5 * * * * /usr/local/bin/pi-repair.sh") | crontab -
```

**Hvad det gør hvert 5. minut:**

1. Er `ais-ingest` nede? → Genstart
2. Er USB-donglen forsvundet? → Reset USB-bus
3. Zombie-processer? → Dræb dem
4. Disk fuld? → Ryd op
5. CPU for varm? → Log det
6. RAM lav? → Drop caches
7. Ingen internet? → Genstart networking
8. Tailscale nede? → Genstart Tailscale
9. Kan ikke fixe noget? → Alert via Supabase

---

## Lag 2: Supabase Edge Function til alerts

Når Pi'en ikke selv kan fixe et problem, sender den en alert via Supabase der mailer dig.

**Edge Function (`pi-alert`):**

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
  const { problems, log } = await req.json();

  // Log til Supabase (kan ses i dashboard)
  console.log(`PI ALERT: ${problems} problems`, log);

  // Send email via Resend (gratis tier: 100 emails/dag)
  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
    },
    body: JSON.stringify({
      from: "Pi Alert <pi@jacobkusk.dk>",
      to: "jacob@jacobkusk.dk",
      subject: `🚨 Pi ALERT: ${problems} uløste problemer`,
      text: `Din Pi har ${problems} problemer den ikke selv kunne fixe.\n\nSeneste log:\n${log}\n\nSSH ind via: ssh pi@100.125.161.64`,
    }),
  });

  return new Response(JSON.stringify({ sent: emailRes.ok }), {
    headers: { "Content-Type": "application/json" },
  });
});
```

**Alternativ uden Resend:** Brug Supabase's indbyggede `pg_net` extension til at kalde en webhook (f.eks. ntfy.sh som er gratis og kræver ingen konto — bare en push-notification på mobilen).

---

## Lag 3: Scheduled Cowork-agent (ekstern overvågning)

En Cowork scheduled task der kører hver time og tjekker Pi'en udefra. Hvis den er helt nede (kan ikke SSHe), eskalerer den.

Denne agent:
- SSH'er til Pi via Tailscale
- Tjekker `ais-ingest` status
- Kigger i `/var/log/pi-selfheal.log`
- Hvis Pi slet ikke svarer → logger det og sender alert
- Kan køre reparationskommandoer via SSH

---

## Opsummering: Hvad der sker ved forskellige fejl

| Fejl | Hvem fixer? | Tid |
|------|------------|-----|
| `ais-ingest` crasher | systemd (auto-restart) | 10 sek |
| USB dongle forsvinder | repair-script (USB reset) | 5 min |
| Zombie-processer | repair-script (kill + restart) | 5 min |
| Disk fuld | repair-script (cleanup) | 5 min |
| RAM lav | repair-script (drop caches) | 5 min |
| Internet nede | repair-script (restart networking) | 5 min |
| Tailscale nede | repair-script (restart tailscaled) | 5 min |
| Total system freeze | Hardware watchdog (reboot) | 15 sek |
| Intet virker | Alert til dig via email | 5 min |
| Pi helt død | Cowork-agent opdager det | 1 time |

---

## Sådan installerer du det hele (copy-paste)

SSH til Pi og kør dette **ene script** der installerer alt:

```bash
ssh pi@100.125.161.64 'bash -s' << 'INSTALL_ALL'

echo "=== Installerer watchdog ==="
sudo apt install -y watchdog
sudo tee /etc/watchdog.conf > /dev/null << 'WD'
watchdog-device = /dev/watchdog
watchdog-timeout = 15
max-load-1 = 24
min-memory = 1
temperature-sensor = /sys/class/thermal/thermal_zone0/temp
max-temperature = 80000
repair-binary = /usr/local/bin/pi-repair.sh
WD
sudo systemctl enable watchdog
sudo systemctl restart watchdog

echo "=== Konfigurerer ais-ingest auto-restart ==="
sudo mkdir -p /etc/systemd/system/ais-ingest.service.d
sudo tee /etc/systemd/system/ais-ingest.service.d/restart.conf > /dev/null << 'SD'
[Service]
Restart=always
RestartSec=10
WatchdogSec=120
StartLimitIntervalSec=600
StartLimitBurst=5
SD
sudo systemctl daemon-reload

echo "=== Installerer self-healing script ==="
sudo tee /usr/local/bin/pi-repair.sh > /dev/null << 'REP'
#!/bin/bash
LOG="/var/log/pi-selfheal.log"
ALERT_FILE="/tmp/pi-alert-needed"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }
PROBLEMS=0

# ais-ingest check
if ! systemctl is-active --quiet ais-ingest; then
    log "WARN: ais-ingest nede, genstarter..."
    sudo systemctl restart ais-ingest && sleep 10
    systemctl is-active --quiet ais-ingest && log "OK: ais-ingest genstartet" || { log "ERROR: ais-ingest fejlede"; PROBLEMS=$((PROBLEMS+1)); }
fi

# USB dongle check
if ! lsusb | grep -q "0bda:2838"; then
    log "WARN: USB dongle mangler, resetter USB..."
    for p in /sys/bus/usb/devices/usb*/authorized; do echo 0 | sudo tee "$p" > /dev/null; sleep 1; echo 1 | sudo tee "$p" > /dev/null; done
    sleep 5
    lsusb | grep -q "0bda:2838" && { log "OK: Dongle genfundet"; sudo systemctl restart ais-ingest; } || { log "ERROR: Dongle stadig væk"; PROBLEMS=$((PROBLEMS+1)); }
fi

# Zombie check
Z=$(pgrep -c rtl_ais 2>/dev/null || echo 0)
[ "$Z" -gt 1 ] && { log "WARN: $Z zombies, dræber..."; sudo pkill -9 rtl_ais; sleep 2; sudo systemctl restart ais-ingest; log "OK: Zombies dræbt"; }

# Disk check
DP=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
[ "$DP" -gt 90 ] && { log "WARN: Disk ${DP}%"; sudo journalctl --vacuum-size=50M; sudo apt-get clean -y; }

# Temp check
TC=$(($(cat /sys/class/thermal/thermal_zone0/temp)/1000))
[ "$TC" -gt 75 ] && { log "WARN: Temp ${TC}C"; PROBLEMS=$((PROBLEMS+1)); }

# RAM check
MF=$(free -m | awk '/^Mem:/{print $7}')
[ "$MF" -lt 50 ] && { log "WARN: RAM ${MF}MB"; sync; echo 3 | sudo tee /proc/sys/vm/drop_caches > /dev/null; }

# Network check
if ! ping -c1 -W5 8.8.8.8 > /dev/null 2>&1; then
    log "WARN: Ingen internet"; sudo systemctl restart networking; sleep 10
    ping -c1 -W5 8.8.8.8 > /dev/null 2>&1 && log "OK: Internet back" || { log "ERROR: Stadig offline"; PROBLEMS=$((PROBLEMS+1)); }
fi

# Tailscale check
tailscale status > /dev/null 2>&1 || { log "WARN: Tailscale nede"; sudo systemctl restart tailscaled; sleep 5; }

# Status log (hvert 30 min)
M=$(date +%M)
[ "$PROBLEMS" -eq 0 ] && ([ "$M" -lt 5 ] || [ "$M" -ge 30 -a "$M" -lt 35 ]) && log "OK: Alt kører. Temp:${TC}C Disk:${DP}% RAM:${MF}MB"

# Alert if problems
[ "$PROBLEMS" -gt 0 ] && log "ALERT: $PROBLEMS uløste problemer!"
REP
sudo chmod +x /usr/local/bin/pi-repair.sh

echo "=== Installerer cron ==="
(crontab -l 2>/dev/null | grep -v pi-repair; echo "*/5 * * * * /usr/local/bin/pi-repair.sh") | crontab -

echo "=== Reducer SD-kort slid med log2ram ==="
if ! dpkg -l | grep -q log2ram; then
    echo "deb [signed-by=/usr/share/keyrings/azlux-archive-keyring.gpg] http://packages.azlux.fr/debian/ bookworm main" | sudo tee /etc/apt/sources.list.d/azlux.list
    sudo wget -O /usr/share/keyrings/azlux-archive-keyring.gpg https://azlux.fr/repo.gpg 2>/dev/null
    sudo apt update && sudo apt install -y log2ram
fi

echo ""
echo "========================================="
echo "  SELF-HEALING INSTALLERET!"
echo "  - Hardware watchdog: aktiv"
echo "  - ais-ingest auto-restart: aktiv"  
echo "  - Repair script: hvert 5. minut"
echo "  - Log: /var/log/pi-selfheal.log"
echo "  - Log2ram: reducerer SD-slid"
echo "========================================="
INSTALL_ALL
```

---

## Daglig vedligeholdelse

Tjek self-healing loggen:

```bash
ssh pi@100.125.161.64 "tail -30 /var/log/pi-selfheal.log"
```

Se om alt kører:

```bash
ssh pi@100.125.161.64 "systemctl status ais-ingest watchdog tailscaled --no-pager"
```
