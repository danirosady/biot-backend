# Bubuhan IoT Backend

Backend service for visual IoT firmware pipeline:
- Generate Arduino code from canvas nodes
- Compile firmware with Arduino CLI
- Upload firmware package to ThingsBoard OTA
- Track async jobs with BullMQ + Redis

## Requirements

- Node.js 18+
- PostgreSQL
- Redis
- Arduino CLI
- ThingsBoard tenant admin access

## Quick Start

```bash
npm install
cp env.example .env
npm run db:generate
npm run db:push
npm run dev
npm run worker
```

API runs on `http://localhost:4000` by default.

## Environment Variables

Use `env.example` as template. Do not commit real credentials.

Important firmware/OTA variables:

- `ARDUINO_CLI_PATH` absolute path to `arduino-cli`
- `ARDUINO_DEFAULT_FQBN` default board (`esp32:esp32:esp32`)
- `ARDUINO_TB_PUBSUBCLIENT_PATH` path to `TBPubSubClient`
- `FIRMWARE_STORAGE_PATH` local binary storage root
- `FIRMWARE_PUBLIC_BASE_URL` optional public base URL for stored binaries
- `OTA_DELIVERY_MODE`
  - `THINGSBOARD_UPLOAD`: upload directly to ThingsBoard OTA API
  - `EXTERNAL_URL`: skip direct upload and log public URL
- `OTA_PACKAGE_TITLE` fixed OTA package title (version is auto-unique)

## Compile & OTA Flow

1. `POST /api/compile` receives canvas + device id
2. Backend generates `.ino` code
3. Worker compiles binary using Arduino CLI
4. Binary is stored under tenant/device path:
   - `public/firmware/{tenantId}/{deviceId}/{file}.bin`
5. OTA behavior depends on mode:
   - `THINGSBOARD_UPLOAD`: create OTA package info, upload package data, then assign if endpoint available
   - `EXTERNAL_URL`: return URL/path for manual ThingsBoard external URL usage

## ThingsBoard Notes

- OTA package uniqueness is `title + version`
- Backend auto-generates unique version suffix to avoid collisions
- Some ThingsBoard distributions do not expose device-assign endpoint; in that case package upload still succeeds and assignment can be done manually in UI

## Useful Commands

```bash
npm run dev      # API server
npm run worker   # BullMQ worker
npm run build    # TypeScript build
npm run db:push  # sync schema
```

## Security Checklist

- Never commit `.env`
- Keep `env.example` as placeholders only
- Rotate leaked keys immediately if they were ever committed

## License

MIT
