# Wiring Studio - Backend

Backend server for Visual IoT IDE with ThingsBoard integration, code generation, and firmware compilation.

## Setup

### Prerequisites
- Node.js 18+
- MySQL database
- Redis server
- Arduino CLI installed

### Installation

```bash
npm install
```

### Database Setup

```bash
# Generate Prisma client
npm run db:generate

# Push schema to database
npm run db:push

# (Optional) Seed database
npm run db:seed
```

### Environment Variables

Create `.env` file (already created with template values):

```env
DATABASE_URL=
THINGSBOARD_BASE_URL=
THINGSBOARD_SYSADMIN_USERNAME=
THINGSBOARD_SYSADMIN_PASSWORD=
ENCRYPTION_KEY=your_32_byte_key_base64
REDIS_URL=redis://localhost:6379
ARDUINO_CLI_PATH=arduino-cli
PORT=4000
```

## Development

```bash
npm run dev
```

Server will start on http://localhost:4000

## Project Structure

```
src/
├── server/              # Main server files (from template-insights)
│   ├── index.ts         # Express app & routes
│   ├── thingsboardClient.ts  # TB API client
│   ├── tbSysAdmin.ts    # Tenant provisioning
│   ├── tbTenant.ts      # Per-tenant operations
│   ├── provisioning.ts  # User-tenant mapping
│   ├── crypto.ts        # Password encryption
│   └── prisma.ts        # Database client
│
├── transpiler/          # TODO: Code generation
│   ├── codeGenerator.ts # Nodes → Arduino C++
│   └── templates/       # Handlebars templates
│
├── compiler/            # TODO: Build system
│   ├── arduinoBuilder.ts # Arduino CLI wrapper
│   └── otaUploader.ts   # ThingsBoard OTA API
│
└── workers/             # TODO: Async jobs
    └── buildQueue.ts    # BullMQ compilation worker

prisma/
├── schema.prisma        # Database schema
├── seed.ts              # Seed data
└── migrations/          # Migration history
```

## API Endpoints

### Authentication (Ready)
- `POST /api/provision/ensure` - Provision ThingsBoard tenant for user

### Devices (Ready)
- `GET /api/devices` - List devices
- `POST /api/devices` - Create device
- `GET /api/devices/:id/attributes` - Get device attributes
- `GET /api/devices/:id/telemetry/latest` - Get latest telemetry

### Projects (TODO)
- `GET /api/projects` - List projects
- `POST /api/projects` - Create project
- `PUT /api/projects/:id` - Update project
- `DELETE /api/projects/:id` - Delete project

### Code Generation (TODO)
- `POST /api/generate-code` - Generate Arduino code
- `POST /api/compile` - Start compilation job
- `GET /api/compile/:jobId/status` - Job status
- `GET /api/compile/:jobId/logs` - Compilation logs

## Next Implementation Steps

### 1. Code Transpiler (`src/transpiler/codeGenerator.ts`)

Create function to convert React Flow nodes to Arduino C++:

```typescript
interface CanvasNode {
  id: string;
  type: 'microcontroller' | 'sensor' | 'chart';
  data: {
    label: string;
    config?: any;
  };
}

interface CanvasEdge {
  source: string;
  target: string;
  sourceHandle: string; // GPIO pin
  targetHandle: string; // Sensor pin
}

function generateArduinoCode(nodes: CanvasNode[], edges: CanvasEdge[]): string {
  // 1. Find ESP32 node
  // 2. Find connected sensors
  // 3. Generate #include statements
  // 4. Generate setup() code
  // 5. Generate loop() code
  // 6. Return complete .ino file
}
```

### 2. Arduino CLI Wrapper (`src/compiler/arduinoBuilder.ts`)

```typescript
import { execa } from 'execa';

async function compileArduino(code: string, boardType: string) {
  const workDir = `/tmp/build-${Date.now()}`;
  // 1. Write code to file
  // 2. Detect & install libraries
  // 3. Run arduino-cli compile
  // 4. Return .bin file path
}
```

### 3. OTA Uploader (`src/compiler/otaUploader.ts`)

```typescript
async function uploadToThingsBoard(binPath: string, deviceId: string) {
  // 1. Create OTA package via TB API
  // 2. Assign to device
  // 3. Trigger OTA update
}
```

### 4. BullMQ Worker (`src/workers/buildQueue.ts`)

```typescript
import { Queue, Worker } from 'bullmq';

const buildQueue = new Queue('firmware-builds', {
  connection: { host: 'localhost', port: 6379 }
});

const worker = new Worker('firmware-builds', async (job) => {
  const { code, boardType, deviceId } = job.data;
  
  // 1. Compile with Arduino CLI
  // 2. Upload to ThingsBoard
  // 3. Update CompileJob in database
}, { connection: { host: 'localhost', port: 6379 } });
```

### 5. Add API Routes (Update `src/server/index.ts`)

```typescript
// Generate code from canvas
app.post('/api/generate-code', async (req, res) => {
  const { nodes, edges } = req.body;
  const code = generateArduinoCode(nodes, edges);
  res.json({ code });
});

// Start compilation job
app.post('/api/compile', async (req, res) => {
  const { code, boardType, deviceId } = req.body;
  const job = await buildQueue.add('compile', {
    code, boardType, deviceId
  });
  res.json({ jobId: job.id });
});

// Get job status
app.get('/api/compile/:jobId/status', async (req, res) => {
  const job = await buildQueue.getJob(req.params.jobId);
  res.json({ 
    status: await job.getState(),
    progress: job.progress 
  });
});
```

## Database Models

### Project
Stores canvas state (nodes, edges, configuration).

### CompileJob
Tracks async compilation jobs with status and logs.

### Firmware
Stores compiled .bin files and metadata.

## Testing

```bash
# Test database connection
npm run db:push

# Test ThingsBoard API
curl http://localhost:4000/api/devices

# Test code generation (after implementation)
curl -X POST http://localhost:4000/api/generate-code \
  -H "Content-Type: application/json" \
  -d '{"nodes": [...], "edges": [...]}'
```

## License

MIT
