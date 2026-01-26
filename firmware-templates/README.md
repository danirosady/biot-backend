# ESP32 Firmware Templates

## Overview

This directory contains firmware templates for ESP32 devices that integrate with Wiring Studio and ThingsBoard.

## Files

### `esp32_ota_base.ino`

**Base firmware with OTA (Over-The-Air) update support.**

This is the **first firmware** you should upload to your ESP32 device. Once uploaded, you can update it remotely from Wiring Studio without connecting USB cables.

**Features:**
- ✅ WiFi connection
- ✅ ThingsBoard integration
- ✅ OTA firmware updates via HTTP
- ✅ RPC callbacks for remote control
- ✅ Device information reporting
- ✅ Remote restart capability
- ✅ Automatic reconnection logic

---

## How to Use

### Step 1: Install Arduino IDE

1. Download Arduino IDE: https://www.arduino.cc/en/software
2. Install and open Arduino IDE

### Step 2: Install ESP32 Board Support

1. Go to **File → Preferences**
2. Add this URL to "Additional Board Manager URLs":
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
3. Go to **Tools → Board → Boards Manager**
4. Search for "esp32" and install "esp32 by Espressif Systems"

### Step 3: Install Required Libraries

Go to **Sketch → Include Library → Manage Libraries**, then install:

1. **ThingsBoard** (by ThingsBoard Team)
2. **ArduinoJson** (by Benoit Blanchon)
3. **PubSubClient** (by Nick O'Leary) - dependency for ThingsBoard

### Step 4: Configure the Firmware

Open `esp32_ota_base.ino` and update these values:

```cpp
// WiFi credentials
const char* WIFI_SSID = "YOUR_WIFI_SSID";      // Your WiFi network name
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";  // Your WiFi password

// ThingsBoard configuration
const char* TB_SERVER = "103.103.20.119";      // Your ThingsBoard server IP
const char* TB_TOKEN = "YOUR_DEVICE_TOKEN";     // Get from ThingsBoard
```

**How to get your Device Token from ThingsBoard:**

1. Login to ThingsBoard: http://103.103.20.119:8080
2. Go to **Devices**
3. Click on your device
4. Go to **Device credentials** tab
5. Copy the **Access token**

### Step 5: Upload to ESP32

1. Connect ESP32 to your computer via USB
2. Select board: **Tools → Board → ESP32 Arduino → DOIT ESP32 DEVKIT V1**
3. Select port: **Tools → Port → COM[X]** (your ESP32 port)
4. Click **Upload** button (→)

### Step 6: Monitor Serial Output

1. Open **Tools → Serial Monitor**
2. Set baud rate to **115200**
3. You should see:
   ```
   ================================
   Wiring Studio - ESP32 OTA Base
   ================================
   
   Chip Model: ESP32-D0WDQ6
   ...
   ✅ WiFi connected!
   IP Address: 192.168.1.100
   ✅ Connected to ThingsBoard!
   ✅ Subscribed to RPC callbacks
   ```

---

## Verify OTA is Working

### Test 1: Check ThingsBoard Connection

In Serial Monitor, you should see:
```
✅ Connected to ThingsBoard!
✅ Subscribed to RPC callbacks
📊 Telemetry sent - Uptime: 10s
```

### Test 2: Check Device in ThingsBoard

1. Go to ThingsBoard → **Devices**
2. Your device should show as **Active**
3. Click on device → **Latest telemetry**
4. You should see: `uptime`, `free_heap`, `rssi`

### Test 3: Test Remote Commands

In ThingsBoard, go to your device and test RPC:

**Get Device Info:**
```json
{
  "method": "get_info",
  "params": {}
}
```

**Restart Device:**
```json
{
  "method": "restart",
  "params": {}
}
```

---

## How OTA Updates Work

1. **You create a project** in Wiring Studio (visual editor)
2. **Click "Compile & Deploy"** - generates firmware and uploads to ThingsBoard
3. **ThingsBoard sends RPC** command `fw_update` to your ESP32
4. **ESP32 downloads** new firmware from ThingsBoard
5. **ESP32 installs** and restarts with new firmware
6. **Done!** No USB cable needed

### OTA Update Flow:

```
Wiring Studio → Compile → Upload to TB → RPC to ESP32 → Download → Install → Restart
```

---

## Troubleshooting

### "WiFi connection failed"
- Check SSID and password
- Make sure WiFi is 2.4GHz (ESP32 doesn't support 5GHz)
- Check WiFi signal strength

### "ThingsBoard connection failed"
- Check TB_SERVER IP address
- Check TB_TOKEN is correct
- Make sure ThingsBoard is accessible from your network
- Check firewall settings

### "Compilation error"
- Make sure all libraries are installed
- Check ESP32 board support is installed
- Try **Tools → Board → ESP32 Arduino → DOIT ESP32 DEVKIT V1**

### "Upload failed"
- Select correct COM port
- Press and hold BOOT button on ESP32 while uploading
- Try different USB cable
- Install CH340 driver if needed

### "OTA update fails"
- Check ESP32 has enough free space (check Serial Monitor: Free Sketch Space)
- Make sure WiFi signal is strong during update
- Check firmware URL is accessible from ESP32

---

## RPC Commands Reference

### `fw_update` - Firmware Update

**Trigger OTA update:**
```json
{
  "method": "fw_update",
  "params": {
    "fw_url": "http://server/firmware.bin",
    "fw_version": "1.0.1",
    "fw_checksum": "optional_md5_hash"
  }
}
```

**Response:**
```json
{
  "ota_status": "success"  // or "failed"
}
```

### `restart` - Restart Device

**Trigger restart:**
```json
{
  "method": "restart",
  "params": {}
}
```

**Response:**
```json
{
  "restart": "ok"
}
```

### `get_info` - Get Device Info

**Request info:**
```json
{
  "method": "get_info",
  "params": {}
}
```

**Response:**
```json
{
  "device_info": {
    "firmware_version": "1.0.0",
    "chip_model": "ESP32-D0WDQ6",
    "chip_revision": 1,
    "cpu_freq": 240,
    "free_heap": 280000,
    "sketch_size": 850000,
    "free_sketch_space": 1310720
  }
}
```

---

## Next Steps

After uploading the base firmware:

1. ✅ Verify device is connected to ThingsBoard
2. ✅ Check telemetry is being received
3. ✅ Test RPC commands (get_info, restart)
4. ✅ Go to Wiring Studio web interface
5. ✅ Create a visual project with sensors
6. ✅ Click "Compile & Deploy"
7. ✅ Watch your ESP32 update automatically!

---

## Security Notes

**For Production:**
- ✅ Use HTTPS for firmware downloads
- ✅ Verify firmware checksums (MD5/SHA256)
- ✅ Implement rollback mechanism
- ✅ Add authentication for RPC commands
- ✅ Use secure WiFi (WPA2/WPA3)
- ✅ Store credentials securely (not hardcoded)

**Current Implementation:**
- ⚠️ Uses HTTP (not HTTPS)
- ⚠️ Credentials hardcoded (for development only)
- ⚠️ No firmware signature verification
- ⚠️ No rollback on failed update

**This is a development/testing firmware. Enhance security for production use.**

---

## Support

For issues:
1. Check Serial Monitor output
2. Check ThingsBoard device logs
3. Verify WiFi and network connectivity
4. Check firmware size (must fit in available space)
5. See main project documentation

## License

MIT
