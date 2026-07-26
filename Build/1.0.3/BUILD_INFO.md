# Water Tank Monitor firmware build 1.0.3

- Board: ESP32 Dev Module (`esp32:esp32:esp32`)
- Sketch: `code/WaterTankSensorSketch.ino`
- Built: 2026-07-26 10:10:15
- App size: ~1104 KB (86% of 1.25 MB app partition)
- Features: OTA GitHub blob URL rewrite, HTTPS redirects, boot/reconnect OTA check, semver compare, device+global firmware manifest

All paths below are relative to the repository root and are case-sensitive on Linux and macOS.

## Files

| File | Use |
|------|-----|
| `WaterTankSensorSketch_fw_1.0.3.bin` | OTA / app image (same as `.ino.bin`) |
| `WaterTankSensorSketch.ino.bin` | App firmware |
| `WaterTankSensorSketch.ino.merged.bin` | Full flash image (bootloader + partitions + app) |
| `WaterTankSensorSketch.ino.bootloader.bin` | Bootloader |
| `WaterTankSensorSketch.ino.partitions.bin` | Partition table |

## USB flash

Flashing uses only the prebuilt binaries in this folder, so no sketch folder is needed:

```powershell
arduino-cli upload -p COMx --fqbn esp32:esp32:esp32 --input-dir Build/1.0.3
```

Replace `COMx` with your serial port (e.g. `COM3`).

## OTA (Firebase)

Set `devices/<deviceId>/firmware.json` or root `firmware.json` to:

```json
{
  "enabled": true,
  "latest_version": "1.0.3",
  "url": "https://raw.githubusercontent.com/raviprakash1/WaterTankMonitoringSystem/main/Build/1.0.3/WaterTankSensorSketch.ino.bin"
}
```

Prefer a raw.githubusercontent.com URL (or a github.com/.../raw/... link). Blob page URLs are rewritten by firmware 1.0.3+, but raw links are more reliable.

## Rebuild from source

Arduino requires the sketch to sit in a folder matching its filename. That folder is generated
rather than committed, so create it first:

```powershell
New-Item -ItemType Directory -Force code/WaterTankSensorSketch
Copy-Item code/WaterTankSensorSketch.ino code/WaterTankSensorSketch/ -Force
arduino-cli compile --fqbn esp32:esp32:esp32 --output-dir Build/1.0.3 code/WaterTankSensorSketch
```
