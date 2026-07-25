# Water Tank Monitor firmware build 1.0.1

- Board: ESP32 Dev Module (`esp32:esp32:esp32`)
- Sketch: `WaterTankSensorSketch.ino`
- Built: 2026-07-25 11:43:54
- App size: ~1090 KB (85% of 1.25 MB app partition)
- Features: persistent WiFi reconnect (no AP trap on disconnect)

## Files

| File | Use |
|------|-----|
| `WaterTankSensorSketch_fw_1.0.1.bin` | OTA / app image (same as `.ino.bin`) |
| `WaterTankSensorSketch.ino.bin` | App firmware |
| `WaterTankSensorSketch.ino.merged.bin` | Full flash image (bootloader + partitions + app) |
| `WaterTankSensorSketch.ino.bootloader.bin` | Bootloader |
| `WaterTankSensorSketch.ino.partitions.bin` | Partition table |

## USB flash

```powershell
arduino-cli upload -p COMx --fqbn esp32:esp32:esp32 --input-dir "builds/1.0.1" "code/WaterTankSensorSketch"
```

Replace `COMx` with your serial port (e.g. `COM3`).
