# Water Tank Monitor firmware build 1.0.4

- Board: ESP32 Dev Module (`esp32:esp32:esp32`)
- Sketch: `code/WaterTankSensorSketch.ino`
- Built: 2026-07-26 10:29:20
- App size: ~1105 KB
- SHA256: `aeabc27e2234e415bba8fa45939686fd99044df05a756ea70d3e13b995c07243`
- Features: sticky WiFi reconnect with radio hard-reset, faster OTA checks (5 min), OTA fail backoff, GitHub blob URL rewrite

## Files

| File | Use |
|------|-----|
| `WaterTankSensorSketch_fw_1.0.4.bin` | OTA / app image |
| `WaterTankSensorSketch.ino.bin` | App firmware |
| `WaterTankSensorSketch.ino.merged.bin` | Full flash (USB) |
| `WaterTankSensorSketch.ino.bootloader.bin` | Bootloader |
| `WaterTankSensorSketch.ino.partitions.bin` | Partition table |

## USB flash

```powershell
arduino-cli upload -p COMx --fqbn esp32:esp32:esp32 --input-dir Build/1.0.4
```

See `docs/BUILD_AND_DEPLOY.md` for OTA + Firebase steps.
