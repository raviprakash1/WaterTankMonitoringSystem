# Build, deploy, and OTA (Firebase)

This guide covers how to compile firmware, publish the `.bin` on GitHub, and tell devices via Firebase to install it automatically over WiFi (OTA). It also explains the optional `sha256` field.

## What the device does by itself

Once provisioned with WiFi credentials:

1. **WiFi stays sticky** — if the router drops, the ESP32 keeps retrying forever (soft reconnect → full `begin()` → periodic radio hard-reset). It does **not** open the setup AP again unless you clear WiFi (`/reconfigure` or portal reset). No power cycle should be required.
2. **OTA check** — on boot (when online), after every WiFi reconnect, and every `ota_check_interval_min` minutes (default **5**).
3. It reads Firebase `firmware` (device path first, then global), compares `latest_version` to its own `FW_VERSION`, downloads the binary from `url`, flashes, and reboots.

You only need to: bump version → build → push bin to GitHub → update Firebase.

---

## Prerequisites

- [Arduino CLI](https://arduino.github.io/arduino-cli/) (or Arduino IDE)
- ESP32 board package: `esp32:esp32`
- Library: **ArduinoJson** (v6 API used by the sketch)
- Git access to this repo
- Firebase Realtime Database write access for the project  
  Root used by this repo:  
  `https://waterlevelmonitor-95f66-default-rtdb.firebaseio.com`

---

## 1. Change the firmware version

In `code/WaterTankSensorSketch.ino`:

```cpp
#define FW_VERSION "1.0.4"
```

Use **semver** `MAJOR.MINOR.PATCH`. Devices only OTA when Firebase `latest_version` is **numerically newer** than the running firmware.

---

## 2. Compile the sketch

Arduino requires the `.ino` inside a folder with the same name. From the repo root (PowerShell):

```powershell
$VER = "1.0.4"

New-Item -ItemType Directory -Force "code/WaterTankSensorSketch" | Out-Null
Copy-Item "code/WaterTankSensorSketch.ino" "code/WaterTankSensorSketch/" -Force
New-Item -ItemType Directory -Force "Build/$VER" | Out-Null

arduino-cli compile --fqbn esp32:esp32:esp32 --output-dir "Build/$VER" code/WaterTankSensorSketch

Copy-Item "Build/$VER/WaterTankSensorSketch.ino.bin" "Build/$VER/WaterTankSensorSketch_fw_$VER.bin" -Force
```

**Use for OTA:** `Build/<version>/WaterTankSensorSketch.ino.bin`  
(same bytes as `WaterTankSensorSketch_fw_<version>.bin`)

**Do not** OTA the `*.merged.bin` (that image includes bootloader + partitions).

`code/WaterTankSensorSketch/` is gitignored — only the single `.ino` under `code/` is source of truth.

---

## 3. Commit and push the binary

```powershell
git add code/WaterTankSensorSketch.ino "Build/$VER"
git commit -m "Ship firmware $VER"
git push origin HEAD
```

After push, the raw download URL must return **HTTP 200** and `application/octet-stream`:

```
https://raw.githubusercontent.com/raviprakash1/WaterTankMonitoringSystem/main/Build/1.0.4/WaterTankSensorSketch.ino.bin
```

**Never** put a GitHub `/blob/` page URL in Firebase — that is an HTML page, not a binary. Firmware 1.0.3+ rewrites blob → raw, but raw links are still preferred.

---

## 4. Update Firebase so devices pick the build

Write the same JSON to **both** (recommended):

| Path | Who uses it |
|------|-------------|
| `/firmware` | All devices (fleet default) |
| `/devices/<deviceId>/firmware` | One device override |

Example for `1.0.4`:

```json
{
  "enabled": true,
  "latest_version": "1.0.4",
  "url": "https://raw.githubusercontent.com/raviprakash1/WaterTankMonitoringSystem/main/Build/1.0.4/WaterTankSensorSketch.ino.bin",
  "published_at": "2026-07-26T12:00:00+05:30",
  "release_notes": "Harder WiFi reconnect + OTA retry backoff",
  "sha256": "<paste-sha256-of-ino-bin-here>"
}
```

### Required fields (OTA)

| Field | Meaning |
|-------|---------|
| `enabled` | `true` to allow downloads; `false` pauses OTA |
| `latest_version` | Must be **newer** than the device’s `FW_VERSION` |
| `url` | Direct HTTPS link to the **app** `.bin` (raw GitHub URL) |

### Optional fields (ops / reports)

| Field | Meaning |
|-------|---------|
| `published_at` | When you published this release |
| `release_notes` | Human-readable changelog |
| `sha256` | See next section |

### PowerShell: publish manifest + SHA

```powershell
$VER = "1.0.4"
$bin = "Build/$VER/WaterTankSensorSketch.ino.bin"
$sha = (Get-FileHash $bin -Algorithm SHA256).Hash.ToLower()
$url = "https://raw.githubusercontent.com/raviprakash1/WaterTankMonitoringSystem/main/Build/$VER/WaterTankSensorSketch.ino.bin"
$base = "https://waterlevelmonitor-95f66-default-rtdb.firebaseio.com"

$body = @{
  enabled = $true
  latest_version = $VER
  url = $url
  published_at = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
  release_notes = "Describe what changed"
  sha256 = $sha
} | ConvertTo-Json

Invoke-RestMethod -Method Put -Uri "$base/firmware.json" -Body $body -ContentType "application/json"
Invoke-RestMethod -Method Put -Uri "$base/devices/device_58992D004F8C/firmware.json" -Body $body -ContentType "application/json"
```

Replace `device_58992D004F8C` with your device id (shown on Serial at boot and in `systeminfo`).

---

## 5. What is `sha256` for?

**SHA-256** is a fingerprint of the exact `.bin` file you published.

- Compute it locally when you build (`Get-FileHash … -Algorithm SHA256`).
- Store it in Firebase next to `url`.
- Use it to confirm the file on GitHub matches what you intended (no corrupt upload, no accidental wrong file).
- Compare: download the raw URL and hash again — hashes must match.

The current ESP32 firmware **does not cryptographically verify** `sha256` before flashing (OTA uses HTTPS download size/stream from `HTTPUpdate`). The field is for **operators and the reports UI**, not a security gate on-device. Keep it anyway so every release is auditable.

---

## 6. First flash vs later OTA

| Situation | Action |
|-----------|--------|
| Brand-new board / never had WiFi | USB flash any recent build, then use AP portal `WaterTankMonitor` → `http://192.168.4.1/` |
| Device already online on older FW | Push bin + set Firebase `latest_version`/`url`; wait for next OTA check (≤ ~5 min, or reboot) |
| Stuck AP with saved WiFi (old bug) | Flash ≥ 1.0.3/1.0.4 over USB once; afterward reconnect is automatic |

USB flash example:

```powershell
arduino-cli upload -p COM3 --fqbn esp32:esp32:esp32 --input-dir Build/1.0.4
```

---

## 7. Verify success

1. Serial (115200): look for `---- OTA CHECK ----`, then `OTA success`, then reboot banner with new `FW:`.
2. Firebase `devices/<id>/systeminfo` → `firmware` equals the new version.
3. Reports dashboard → Device tab → firmware / bootstrap show the new version.

If OTA fails: confirm raw URL returns 200, `enabled` is true, version is newer, and WiFi is stable. Failed OTAs back off for a few minutes then retry.

---

## Lean Firebase shape (keep only what code needs)

Per device, the firmware and reports use roughly:

- `tank_live`, `history`, `config`, `bootstrap`, `systeminfo`, `logs`, `errors`, `firmware`
- Global: `firmware` (fleet OTA)

Do not store duplicate OTA metadata (`bin_url`, `fw_url`, board paths, etc.) — one `url` + `latest_version` + `enabled` is enough for the device.
