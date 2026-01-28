import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import path from "path";
import { decrypt } from "./crypto";
import { prisma } from "./prisma";
import { ensureTenantForGoogleUser } from "./provisioning";
import { sensorDataService } from './sensorDataService';
import { tenantCreateDevice, tenantDeleteDevice, tenantGetDeviceInfo, tenantListDevices, tenantUpdateDevice } from "./tbTenant";
import { getAggregatedTelemetry, getAttributes, getDeviceInfo, getLatestTelemetry, getTelemetryHistory, listDevices } from "./thingsboardClient";
import { generateArduinoCode, extractDeviceConfig } from "../transpiler/codeGenerator";
import { queueCompilationJob, getJobStatus } from "../workers/buildQueue";
import { verifyGoogleToken, validateEmailVerified } from "./auth/googleOAuth";
import { generateTokens, verifyRefreshToken } from "./auth/jwtUtils";
import { authenticateToken, optionalAuth, getUserFromRequest } from "./auth/authMiddleware";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

const app = express();

// Trust reverse proxy (when running behind Nginx/Apache)
app.set("trust proxy", 1);

// Helmet with relaxed CORP if you proxy static resources
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// CORS configuration for Vercel frontend + VPS backend
const getCorsOrigins = () => {
  const origins = (process.env.ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Default development origins
  if (origins.length === 0) {
    return [
      "http://localhost:3000",
      "http://localhost:3001", 
      "http://localhost:5173",
      "http://127.0.0.1:5173"
    ];
  }

  return origins;
};

const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (!origin) return true; // Allow server-to-server requests

  const allowedOrigins = getCorsOrigins();
  
  // Check exact matches
  if (allowedOrigins.includes(origin)) return true;
  
  // Check for Vercel deployments (both production and preview)
  if (origin.includes('vercel.app')) return true;
  
  return false;
};

app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server or tools without Origin
      if (!origin) return callback(null, true);
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: false,
  })
);

app.use(express.json());

// ==================== AUTHENTICATION ENDPOINTS ====================

/**
 * POST /api/auth/google
 * Exchange Google ID token for JWT
 */
app.post("/api/auth/google", async (req, res) => {
  try {
    const { idToken } = req.body;
    
    if (!idToken) {
      return res.status(400).json({ error: "idToken is required" });
    }

    // Verify Google token and get user info
    const googleUser = await verifyGoogleToken(idToken);
    validateEmailVerified(googleUser);

    // Ensure user exists in database and has tenant provisioned
    const result = await ensureTenantForGoogleUser(
      googleUser.sub,
      googleUser.email,
      googleUser.name
    );

    // Generate JWT tokens
    const tokens = generateTokens(result.user);

    res.json({
      ...tokens,
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        googleSub: result.user.googleSub,
      },
      tenant: {
        id: result.tenant.id,
        tbTenantId: result.tenant.tbTenantId,
      },
    });
  } catch (error: any) {
    console.error("Google auth error:", error);
    res.status(401).json({ error: error.message || "Authentication failed" });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh JWT access token using refresh token
 */
app.post("/api/auth/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(400).json({ error: "refreshToken is required" });
    }

    // Verify refresh token
    const payload = verifyRefreshToken(refreshToken);
    
    if (!payload) {
      return res.status(401).json({ error: "Invalid refresh token" });
    }

    // Get user from database
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    // Generate new tokens
    const tokens = generateTokens(user);

    res.json(tokens);
  } catch (error: any) {
    console.error("Token refresh error:", error);
    res.status(401).json({ error: "Token refresh failed" });
  }
});

/**
 * GET /api/auth/me
 * Get current authenticated user
 */
app.get("/api/auth/me", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: {
        links: {
          include: {
            tenant: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      googleSub: user.googleSub,
      tenants: user.links.map((link: { tenant: { id: string; tbTenantId: string; title: string } }) => ({
        id: link.tenant.id,
        tbTenantId: link.tenant.tbTenantId,
        title: link.tenant.title,
      })),
    });
  } catch (error: any) {
    console.error("Get user error:", error);
    res.status(500).json({ error: "Failed to get user" });
  }
});

/**
 * POST /api/auth/logout
 * Logout (client-side token deletion)
 */
app.post("/api/auth/logout", (req, res) => {
  // With JWT, logout is handled client-side by removing the token
  // This endpoint exists for consistency and potential future server-side session management
  res.json({ message: "Logged out successfully" });
});

// Provisioning endpoint: ensure TB tenant/admin for a Google user
app.post("/api/provision/ensure", async (req, res) => {
  try {
    const { sub, email, name } = req.body ?? {};
    if (!sub || !email) return res.status(400).json({ error: "sub and email are required" });
    const result = await ensureTenantForGoogleUser(sub, email, name);
    res.json({
      userId: result.user.id,
      tbTenantId: result.tenant.tbTenantId,
      tbTenantAdminUserId: result.tenantAdmin.tbTenantAdminUserId,
    });
  } catch (e: any) {
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// List devices (paginated) - uses JWT authentication
app.get("/api/devices", authenticateToken, async (req, res) => {
  try {
    const page = Number(req.query.page ?? 0);
    const pageSize = Number(req.query.pageSize ?? 20);
    const type = req.query.type as string | undefined;

    // Get user from JWT token
    const userInfo = getUserFromRequest(req);
    
    if (!userInfo) {
      return res.status(401).json({ error: "Authentication required" });
    }

    console.log(`Fetching devices for user: ${userInfo.email}`);
    
    // Ensure tenant mapping and query under that tenant admin
    const ensured = await ensureTenantForGoogleUser(userInfo.sub, userInfo.email, userInfo.name);
    
    console.log(`Using tenant: ${ensured.tenant.title} (TB ID: ${ensured.tenant.tbTenantId})`);
    
    // Load encrypted password from DB
    const link = await prisma.userTenantLink.findFirstOrThrow({
      where: { tbTenantAdminUserId: ensured.tenantAdmin.tbTenantAdminUserId },
    });
    const password = decrypt(link.tbServicePasswordEnc);
    
    const data = await tenantListDevices({
      email: userInfo.email,
      password,
      cacheKey: ensured.tenantAdmin.tbTenantAdminUserId,
      page,
      pageSize,
      type,
    });
    
    console.log(`Found ${data.totalElements} device(s) in tenant`);
    
    return res.json(data);
  } catch (e: any) {
    console.error("Error listing devices:", e);
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Create device as tenant admin - uses JWT authentication
app.post("/api/devices", authenticateToken, async (req, res) => {
  try {
    const userInfo = getUserFromRequest(req);
    
    if (!userInfo) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { name, type, label, additionalInfo } = req.body ?? {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Device name is required" });
    }

    const ensured = await ensureTenantForGoogleUser(userInfo.sub, userInfo.email, userInfo.name);

    const link = await prisma.userTenantLink.findFirstOrThrow({
      where: { tbTenantAdminUserId: ensured.tenantAdmin.tbTenantAdminUserId },
    });
    const password = decrypt(link.tbServicePasswordEnc);

    const device = await tenantCreateDevice({
      email: userInfo.email,
      password,
      cacheKey: ensured.tenantAdmin.tbTenantAdminUserId,
      name,
      type,
      label,
      additionalInfo,
    });

    res.status(201).json({ device });
  } catch (e: any) {
    console.error("Error creating device:", e);
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Update device as tenant admin - uses JWT authentication
app.put("/api/devices/:id", authenticateToken, async (req, res) => {
  try {
    const userInfo = getUserFromRequest(req);
    
    if (!userInfo) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Device id is required" });

    const { name, type, label, additionalInfo } = req.body ?? {};
    if (!name && !type && !label && additionalInfo === undefined) {
      return res.status(400).json({ error: "Provide at least one field to update" });
    }

    const ensured = await ensureTenantForGoogleUser(userInfo.sub, userInfo.email, userInfo.name);

    const link = await prisma.userTenantLink.findFirstOrThrow({
      where: { tbTenantAdminUserId: ensured.tenantAdmin.tbTenantAdminUserId },
    });
    const password = decrypt(link.tbServicePasswordEnc);

    const device = await tenantUpdateDevice({
      email: userInfo.email,
      password,
      cacheKey: ensured.tenantAdmin.tbTenantAdminUserId,
      deviceId: id as string,
      name,
      type,
      label,
      additionalInfo,
    });

    res.json({ device });
  } catch (e: any) {
    console.error("Error updating device:", e);
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Get attributes for a device
app.get("/api/devices/:id/attributes", async (req, res) => {
  try {
    const { id } = req.params;
    const scopeParam = (req.query.scope as string) ?? "SERVER_SCOPE";
    const scope = ["SERVER_SCOPE", "SHARED_SCOPE", "CLIENT_SCOPE"].includes(scopeParam)
      ? (scopeParam as any)
      : "SERVER_SCOPE";
    const attrs = await getAttributes(id, scope);
    res.json(attrs);
  } catch (e: any) {
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Get latest telemetry for a device
app.get("/api/devices/:id/telemetry/latest", async (req, res) => {
  try {
    const { id } = req.params;
    const keys = (req.query.keys as string) ?? undefined; // e.g. "battery,temperature"
    const telemetry = await getLatestTelemetry(id, keys);
    res.json(telemetry);
  } catch (e: any) {
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Delete device as tenant admin - uses JWT authentication
app.delete("/api/devices/:id", authenticateToken, async (req, res) => {
  try {
    const userInfo = getUserFromRequest(req);
    
    if (!userInfo) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Device id is required" });

    const ensured = await ensureTenantForGoogleUser(userInfo.sub, userInfo.email, userInfo.name);

    const link = await prisma.userTenantLink.findFirstOrThrow({
      where: { tbTenantAdminUserId: ensured.tenantAdmin.tbTenantAdminUserId },
    });
    const password = decrypt(link.tbServicePasswordEnc);

    await tenantDeleteDevice({
      email: userInfo.email,
      password,
      cacheKey: ensured.tenantAdmin.tbTenantAdminUserId,
      deviceId: id as string,
    });

    return res.status(204).end();
  } catch (e: any) {
    console.error("Error deleting device:", e);
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Get device details (including additionalInfo)
app.get("/api/devices/:id/details", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Device id is required" });
    
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (userSub && userEmail) {
      // Use tenant-specific client
      const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);
      const link = await prisma.userTenantLink.findFirstOrThrow({
        where: { tbTenantAdminUserId: ensured.tenantAdmin.tbTenantAdminUserId },
      });
      const password = decrypt(link.tbServicePasswordEnc);
      
      // Add tenantGetDeviceInfo function to tbTenant.ts if it doesn't exist
      const deviceInfo = await tenantGetDeviceInfo({
        email: userEmail,
        password,
        cacheKey: ensured.tenantAdmin.tbTenantAdminUserId,
        deviceId: id,
      });
      
      return res.json(deviceInfo);
    }
    
    // Fallback to single-tenant client
    const deviceInfo = await getDeviceInfo(id);
    res.json(deviceInfo);
  } catch (e: any) {
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Get device data (sensors data + telemetry)
app.get("/api/devices/:id/data", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Device id is required" });
    
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing x-user-sub and x-user-email headers" });
    }

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);
    
    // Get query parameters
    const startTime = req.query.startTime as string;
    const endTime = req.query.endTime as string;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
    const includeThingsBoard = req.query.includeThingsBoard === 'true';

    // Get sensors for this device
    const sensors = await prisma.sensor.findMany({
      where: { deviceId: id },
      include: { sensorType: { include: { outputs: true } } }
    });

    let localData: any[] = [];
    let thingsBoardData: any[] = [];

    // Get local sensor data
    for (const sensor of sensors) {
      try {
        const sensorData = await sensorDataService.getSensorData(
          {
            sensorId: sensor.id,
            startTime: startTime ? new Date(startTime) : undefined,
            endTime: endTime ? new Date(endTime) : undefined,
            limit,
            includeThingsBoard: false
          },
          ensured.tenant.id
        );
        localData = [...localData, ...sensorData.localData];

      } catch (error) {
        console.error(`Error fetching local data for sensor ${sensor.id}:`, error);
      }
    }

    // Get ThingsBoard telemetry data if requested
    if (includeThingsBoard) {
      try {
        const telemetry = await getLatestTelemetry(id);
        if (telemetry && Object.keys(telemetry).length > 0) {
          // Transform telemetry to match expected format
          const telemetryData = Object.entries(telemetry).map(([key, value]: [string, any]) => ({
            timestamp: new Date(value.ts || Date.now()).toISOString(),
            sensorId: `tb_${key}`,
            rawData: { [key]: value.value },
            processedData: { [key]: value.value },
            quality: 'GOOD',
            source: 'thingsboard'
          }));
          thingsBoardData = telemetryData;
        }
      } catch (error) {
        console.error(`Error fetching ThingsBoard data for device ${id}:`, error);
      }
    }

    // Combine and sort data by timestamp
    const allData = [...localData, ...thingsBoardData]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);

    res.json({
      localData,
      thingsBoardData,
      combinedData: allData,
      sensors,
      deviceId: id
    });
  } catch (e: any) {
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Sensor Types API endpoints
app.get("/api/sensor-types", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing x-user-sub and x-user-email headers" });
    }

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);
    
    const sensorTypes = await prisma.sensorType.findMany({
      include: { outputs: true, sensors: true }
    });
    
    // Transform requiredPins to pinRequirements for frontend compatibility
    const transformedSensorTypes = sensorTypes.map((sensorType: { requiredPins: unknown; [key: string]: unknown }) => ({
      ...sensorType,
      pinRequirements: sensorType.requiredPins,
      requiredPins: undefined // Remove the original field
    }));
    
    res.json({ data: transformedSensorTypes });
  } catch (e: any) {
    const status = 500;
    const body = { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

app.post("/api/sensor-types", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing x-user-sub and x-user-email headers" });
    }

    const { name, description, pinRequirements, outputs, category } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });
    if (!category) return res.status(400).json({ error: "Category is required" });

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);
    
    const sensorType = await prisma.sensorType.create({
      data: {
        name,
        description,
        category,
        requiredPins: pinRequirements,
        outputs: {
          create: outputs || []
        }
      },
      include: { outputs: true }
    });
    
    res.json({ sensorType });
  } catch (e: any) {
    const status = 500;
    const body = { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

app.put("/api/sensor-types/:id", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing x-user-sub and x-user-email headers" });
    }

    const { id } = req.params;
    const { name, description, pinRequirements, category } = req.body;
    
    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);
    
    const sensorType = await prisma.sensorType.update({
      where: { 
        id
      },
      data: {
        name,
        description,
        category,
        requiredPins: pinRequirements
      },
      include: { outputs: true }
    });
    
    res.json({ sensorType });
  } catch (e: any) {
    const status = 500;
    const body = { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

app.delete("/api/sensor-types/:id", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing x-user-sub and x-user-email headers" });
    }

    const { id } = req.params;
    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);
    
    await prisma.sensorType.delete({
      where: { 
        id
      }
    });
    
    res.status(204).end();
  } catch (e: any) {
    const status = 500;
    const body = { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Sensors API endpoints - uses JWT authentication
// TEMPORARY: Show all sensors regardless of tenant
app.get("/api/sensors", authenticateToken, async (req, res) => {
  try {
    const userInfo = getUserFromRequest(req);
    
    if (!userInfo) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // TEMPORARY FIX: Show all sensors (no tenant filtering)
    console.log(`Fetching all sensors for user: ${userInfo.email}`);
    
    // Add device filtering support
    const { deviceId } = req.query;
    
    const whereClause: any = {};
    
    // Filter by device if deviceId is provided
    if (deviceId && typeof deviceId === 'string') {
      whereClause.deviceId = deviceId;
    }
    
    const sensors = await prisma.sensor.findMany({
      where: whereClause,
      include: { 
        sensorType: { include: { outputs: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    console.log(`Found ${sensors.length} sensor(s)`);
    
    // Return in the format expected by frontend
    res.json({
      data: sensors,
      totalPages: 1,
      totalElements: sensors.length,
      hasNext: false
    });
  } catch (e: any) {
    console.error("Error listing sensors:", e);
    const status = 500;
    const body = { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

app.post("/api/sensors", authenticateToken, async (req, res) => {
  try {
    const userInfo = getUserFromRequest(req);
    
    if (!userInfo) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { name, deviceId, deviceName, sensorTypeId, pinConfiguration, outputConfiguration } = req.body;
    if (!name || !deviceId || !sensorTypeId) {
      return res.status(400).json({ error: "Name, deviceId, and sensorTypeId are required" });
    }

    const ensured = await ensureTenantForGoogleUser(userInfo.sub, userInfo.email, userInfo.name);

    const sensor = await prisma.sensor.create({
      data: {
        name,
        deviceId,
        deviceName,
        sensorTypeId,
        pinMapping: pinConfiguration || {},
        outputConfig: outputConfiguration || {},
        tenantId: ensured.tenant.id
      },
      include: { 
        sensorType: { include: { outputs: true } }
      }
    });
    
    res.json({ sensor });
  } catch (e: any) {
    const status = 500;
    const body = { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

app.put("/api/sensors/:id", authenticateToken, async (req, res) => {
  try {
    const userInfo = getUserFromRequest(req);
    
    if (!userInfo) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { id } = req.params;
    const { name, deviceId, deviceName, sensorTypeId, pinMapping, outputConfig, outputTemplate, isActive } = req.body;
    
    const ensured = await ensureTenantForGoogleUser(userInfo.sub, userInfo.email, userInfo.name);

    // Build update data object with only provided fields
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (deviceId !== undefined) updateData.deviceId = deviceId;
    if (deviceName !== undefined) updateData.deviceName = deviceName;
    if (sensorTypeId !== undefined) updateData.sensorTypeId = sensorTypeId;
    if (pinMapping !== undefined) updateData.pinMapping = pinMapping;
    if (outputConfig !== undefined) updateData.outputConfig = outputConfig;
    if (outputTemplate !== undefined) updateData.outputTemplate = outputTemplate;
    if (isActive !== undefined) updateData.isActive = isActive;

    const sensor = await prisma.sensor.update({
      where: { 
        id,
        tenantId: ensured.tenant.id 
      },
      data: updateData,
      include: { 
        sensorType: { include: { outputs: true } }
      }
    });
    
    res.json({ sensor });
  } catch (e: any) {
    const status = 500;
    const body = { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

app.delete("/api/sensors/:id", authenticateToken, async (req, res) => {
  try {
    const userInfo = getUserFromRequest(req);
    
    if (!userInfo) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { id } = req.params;
    const ensured = await ensureTenantForGoogleUser(userInfo.sub, userInfo.email, userInfo.name);
    
    await prisma.sensor.delete({
      where: { 
        id,
        tenantId: ensured.tenant.id 
      }
    });
    
    res.status(204).end();
  } catch (e: any) {
    const status = 500;
    const body = { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Sensor Data API endpoints
// Enhanced sensor data endpoint
app.post("/api/sensors/:id/data", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing x-user-sub and x-user-email headers" });
    }

    const { id } = req.params;
    const { rawData, quality, timestamp, syncToThingsBoard = true } = req.body;
    
    if (!rawData) {
      return res.status(400).json({ error: "rawData is required" });
    }

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);
    
    const sensorData = await sensorDataService.storeSensorData({
      sensorId: id,
      rawData,
      quality,
      timestamp: timestamp ? new Date(timestamp) : undefined
    }, ensured.tenant.id);
    
    res.json({ sensorData });
  } catch (e: any) {
    const status = 500;
    const body = { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Enhanced sensor data retrieval
app.get("/api/sensors/:id/data", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing x-user-sub and x-user-email headers" });
    }

    const { id } = req.params;
    const limit = Number(req.query.limit ?? 100);
    const startTime = req.query.startTime ? new Date(req.query.startTime as string) : undefined;
    const endTime = req.query.endTime ? new Date(req.query.endTime as string) : undefined;
    const includeThingsBoard = req.query.includeThingsBoard === 'true';
    const aggregation = req.query.aggregation ? {
      interval: Number(req.query.interval ?? 3600000), // 1 hour default
      function: (req.query.agg as any) || 'AVG'
    } : undefined;

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);
    
    const result = await sensorDataService.getSensorData({
      sensorId: id,
      startTime,
      endTime,
      limit,
      includeThingsBoard,
      aggregation
    }, ensured.tenant.id);
    
    res.json(result);
  } catch (e: any) {
    const status = 500;
    const body = { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Sensor data statistics
app.get("/api/sensors/:id/data/stats", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing x-user-sub and x-user-email headers" });
    }

    const { id } = req.params;
    const startTime = req.query.startTime ? new Date(req.query.startTime as string) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const endTime = req.query.endTime ? new Date(req.query.endTime as string) : new Date();

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);
    
    const stats = await sensorDataService.getSensorDataStats(id, ensured.tenant.id, {
      startTime,
      endTime
    });
    
    res.json(stats);
  } catch (e: any) {
    const status = 500;
    const body = { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Delete sensor data
app.delete("/api/sensors/:id/data", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing x-user-sub and x-user-email headers" });
    }

    const { id } = req.params;
    const startTime = req.query.startTime ? new Date(req.query.startTime as string) : undefined;
    const endTime = req.query.endTime ? new Date(req.query.endTime as string) : undefined;
    const deleteFromThingsBoard = req.query.deleteFromThingsBoard === 'true';

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);
    
    await sensorDataService.deleteSensorData(id, ensured.tenant.id, {
      startTime,
      endTime,
      deleteFromThingsBoard
    });
    
    res.status(204).end();
  } catch (e: any) {
    const status = 500;
    const body = { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Bulk sensor data upload
app.post("/api/sensors/:id/data/bulk", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing x-user-sub and x-user-email headers" });
    }

    const { id } = req.params;
    const { dataPoints } = req.body; // Array of { rawData, quality?, timestamp? }
    
    if (!Array.isArray(dataPoints) || dataPoints.length === 0) {
      return res.status(400).json({ error: "dataPoints array is required" });
    }

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);
    
    const results = [];
    for (const dataPoint of dataPoints) {
      try {
        const sensorData = await sensorDataService.storeSensorData({
          sensorId: id,
          rawData: dataPoint.rawData,
          quality: dataPoint.quality,
          timestamp: dataPoint.timestamp ? new Date(dataPoint.timestamp) : undefined
        }, ensured.tenant.id);
        results.push({ success: true, data: sensorData });
      } catch (error: any) {
        results.push({ success: false, error: error.message });
      }
    }
    
    res.json({ results });
  } catch (e: any) {
    const status = 500;
    const body = { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Add tenant helper functions for telemetry
const TB_BASE_URL = (process.env.THINGSBOARD_BASE_URL ?? "").trim().replace(/\/+$/, "");

type TokenCache = { token: string | null; expiresAt: number };
const tokenCacheByUserId = new Map<string, TokenCache>();

async function tenantLogin(email: string, password: string, cacheKey: string): Promise<string> {
  const now = Date.now();
  const cache = tokenCacheByUserId.get(cacheKey) ?? { token: null, expiresAt: 0 };
  if (cache.token && now < cache.expiresAt - 10_000) return cache.token;

  const { data } = await axios.post(`${TB_BASE_URL}/api/auth/login`, { username: email, password });
  const token: string = data.token || data.accessToken;
  if (!token) throw new Error("Tenant login response missing token");

  const newCache: TokenCache = { token, expiresAt: 0 };
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    newCache.expiresAt = (payload.exp ?? Math.floor(now / 1000) + 600) * 1000;
  } catch {
    newCache.expiresAt = now + 10 * 60 * 1000;
  }
  tokenCacheByUserId.set(cacheKey, newCache);
  return token;
}

async function tenantRequest<T>(cfg: { method: "GET" | "POST" | "DELETE"; url: string; params?: any; data?: any }, token: string) {
  const res = await axios.request<T>({
    method: cfg.method,
    url: `${TB_BASE_URL}${cfg.url}`,
    params: cfg.params,
    data: cfg.data,
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

// Latest telemetry for all sensors in tenant
app.get("/api/telemetry/latest", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing authentication headers" });
    }

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);

    const sensors = await prisma.sensor.findMany({
      where: { tenantId: ensured.tenant.id },
      include: { sensorType: { include: { outputs: true } } }
    });

    // Get tenant service password and token
    const link = await prisma.userTenantLink.findFirstOrThrow({
      where: { tbTenantAdminUserId: ensured.tenantAdmin.tbTenantAdminUserId },
    });
    const password = decrypt(link.tbServicePasswordEnc);
    const token = await tenantLogin(userEmail, password, ensured.tenantAdmin.tbTenantAdminUserId);

    const items = await Promise.all(
      sensors.map(async (sensor: { deviceId: string | null; name: string; deviceName: string | null; sensorType: { outputs: Array<{ name: string }> } }) => {
        if (!sensor.deviceId) return null;
        try {
          const keys = sensor.sensorType.outputs.map((o) => `${sensor.name}_${o.name}`);
          // include meta keys if present
          const keysParam = keys.join(",");

          const data = await tenantRequest<Record<string, Array<{ ts: number; value: any }>>>({
            method: "GET",
            url: `/api/plugins/telemetry/DEVICE/${sensor.deviceId}/values/timeseries`,
            params: { keys: keysParam, useStrictDataTypes: true },
          }, token);

          // Build latest sample across keys
          const latestSample: { ts: number; rawData: Record<string, any> } = { ts: 0, rawData: {} };
          Object.entries(data || {}).forEach(([key, arr]) => {
            if (!Array.isArray(arr) || arr.length === 0) return;
            const last = arr[arr.length - 1];
            const cleanKey = key.replace(`${sensor.name}_`, "");
            latestSample.rawData[cleanKey] = last.value;
            if (last.ts > latestSample.ts) latestSample.ts = last.ts;
          });

          if (!latestSample.ts) return null;

          return {
            timestamp: new Date(latestSample.ts).toISOString(),
            deviceName: sensor.deviceName || sensor.deviceId,
            sensorName: sensor.name,
            seriesData: latestSample.rawData,
            status: (latestSample.rawData["quality"] as string) || "UNKNOWN",
          };
        } catch {
          return null;
        }
      })
    );

    res.json(items.filter(Boolean));
  } catch (e: any) {
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

app.get("/api/telemetry/history", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing authentication headers" });
    }

    const { deviceId, keys, startTs, endTs, interval, agg } = req.query;
    
    if (!deviceId || !keys || !startTs || !endTs) {
      return res.status(400).json({ error: "Missing required parameters: deviceId, keys, startTs, endTs" });
    }

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);
    
    let telemetryData;
    const keysArray = (keys as string).split(',');
    
    if (interval && agg) {
      // Get aggregated data
      telemetryData = await getAggregatedTelemetry(
        deviceId as string,
        keysArray,
        parseInt(startTs as string),
        parseInt(endTs as string),
        parseInt(interval as string),
        agg as 'MIN' | 'MAX' | 'AVG' | 'SUM' | 'COUNT'
      );
    } else {
      // Get raw historical data
      telemetryData = await getTelemetryHistory(
        deviceId as string,
        keysArray,
        parseInt(startTs as string),
        parseInt(endTs as string)
      );
    }

    res.json(telemetryData);
  } catch (e: any) {
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

app.get("/api/telemetry/aggregated", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing authentication headers" });
    }

    const { keys, startTs, endTs, interval, agg, deviceIds } = req.query;
    
    if (!keys || !startTs || !endTs || !interval || !agg) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);
    
    // Get tenant credentials
    const link = await prisma.userTenantLink.findFirstOrThrow({
      where: { tbTenantAdminUserId: ensured.tenantAdmin.tbTenantAdminUserId },
    });
    const password = decrypt(link.tbServicePasswordEnc);
    
    // Use tenant-specific device listing
    const devices = await tenantListDevices({
      email: userEmail,
      password,
      cacheKey: ensured.tenantAdmin.tbTenantAdminUserId,
      page: 0,
      pageSize: 100
    });
    
    console.log(`Found ${devices.data.length} devices for tenant ${userEmail}`);
    
    // Filter devices if deviceIds parameter is provided
    let filteredDevices = devices.data;
    if (deviceIds && typeof deviceIds === 'string') {
      const selectedDeviceIds = deviceIds.split(',');
      filteredDevices = devices.data.filter((device: any) => 
        selectedDeviceIds.includes(device.id.id)
      );
      console.log(`Filtered to ${filteredDevices.length} selected devices`);
    }
    
    // If no devices found, return empty array
    if (filteredDevices.length === 0) {
      console.log("No devices found for tenant, returning empty array");
      return res.json([]);
    }
    
    // Get tenant token once for all requests
    const token = await tenantLogin(userEmail, password, ensured.tenantAdmin.tbTenantAdminUserId);
    
    const telemetryPromises = filteredDevices.map(async (device: any) => {
      try {
        // Use tenant-specific token for telemetry requests with correct endpoint
        const data = await tenantRequest({
          method: "GET",
          url: `/api/plugins/telemetry/DEVICE/${device.id.id}/values/timeseries`,
          params: {
            keys: keys as string,
            startTs: parseInt(startTs as string),
            endTs: parseInt(endTs as string),
            interval: parseInt(interval as string),
            agg: agg as string,
            useStrictDataTypes: true
          }
        }, token);
        
        return { deviceId: device.id.id, deviceName: device.name, data };
      } catch (error) {
        console.error(`Failed to get telemetry for device ${device.id.id}:`, error);
        return { deviceId: device.id.id, deviceName: device.name, data: null };
      }
    });
    
    const results = await Promise.all(telemetryPromises);
    
    // Filter out failed requests
    const validResults = results.filter(result => result.data !== null);
    
    console.log(`Successfully retrieved telemetry for ${validResults.length} out of ${filteredDevices.length} devices`);
    
    res.json(validResults);
  } catch (e: any) {
    console.error("Error in /api/telemetry/aggregated:", e);
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// ============================================================================
// CODE GENERATION ENDPOINTS
// ============================================================================

// Generate Arduino code from canvas nodes
app.post("/api/generate-code", async (req, res) => {
  try {
    const { nodes, edges, config } = req.body;

    if (!nodes || !Array.isArray(nodes)) {
      return res.status(400).json({ error: "Invalid nodes array" });
    }

    if (!edges || !Array.isArray(edges)) {
      return res.status(400).json({ error: "Invalid edges array" });
    }

    // Generate Arduino code
    const result = generateArduinoCode(nodes, edges, config);

    res.json({
      success: true,
      code: result.code,
      libraries: result.libraries,
      validation: result.validation,
    });
  } catch (e: any) {
    console.error("Error generating code:", e);
    res.status(500).json({
      success: false,
      error: e?.message ?? "Failed to generate code",
    });
  }
});

// Save project with canvas data
app.post("/api/projects", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing authentication headers" });
    }

    const { name, description, canvasData } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Project name is required" });
    }

    if (!canvasData || !canvasData.nodes || !canvasData.edges) {
      return res.status(400).json({ error: "Invalid canvas data" });
    }

    // Ensure tenant
    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);

    // Create project
    const project = await prisma.project.create({
      data: {
        name,
        description,
        canvasData,
        tenantId: ensured.tenant.id,
      },
    });

    res.status(201).json({ success: true, project });
  } catch (e: any) {
    console.error("Error creating project:", e);
    res.status(500).json({
      error: e?.message ?? "Failed to create project",
    });
  }
});

// Get user projects
app.get("/api/projects", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing authentication headers" });
    }

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);

    const projects = await prisma.project.findMany({
      where: { tenantId: ensured.tenant.id },
      orderBy: { updatedAt: "desc" },
    });

    res.json({ success: true, projects });
  } catch (e: any) {
    console.error("Error fetching projects:", e);
    res.status(500).json({
      error: e?.message ?? "Failed to fetch projects",
    });
  }
});

// Update project
app.put("/api/projects/:id", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing authentication headers" });
    }

    const { id } = req.params;
    const { name, description, canvasData } = req.body;

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);

    // Check ownership
    const existing = await prisma.project.findFirst({
      where: { id, tenantId: ensured.tenant.id },
    });

    if (!existing) {
      return res.status(404).json({ error: "Project not found" });
    }

    // Update project
    const project = await prisma.project.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(canvasData && { canvasData }),
      },
    });

    res.json({ success: true, project });
  } catch (e: any) {
    console.error("Error updating project:", e);
    res.status(500).json({
      error: e?.message ?? "Failed to update project",
    });
  }
});

// Delete project
app.delete("/api/projects/:id", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing authentication headers" });
    }

    const { id } = req.params;

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);

    // Check ownership
    const existing = await prisma.project.findFirst({
      where: { id, tenantId: ensured.tenant.id },
    });

    if (!existing) {
      return res.status(404).json({ error: "Project not found" });
    }

    await prisma.project.delete({ where: { id } });

    res.json({ success: true, message: "Project deleted" });
  } catch (e: any) {
    console.error("Error deleting project:", e);
    res.status(500).json({
      error: e?.message ?? "Failed to delete project",
    });
  }
});

// ============================================================================
// COMPILATION ENDPOINTS
// ============================================================================

// Start firmware compilation job
app.post("/api/compile", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing authentication headers" });
    }

    const { nodes, edges, deviceId, version, config } = req.body;

    if (!nodes || !edges) {
      return res.status(400).json({ error: "Missing nodes or edges" });
    }

    if (!deviceId) {
      return res.status(400).json({ error: "Device ID is required" });
    }

    // Ensure tenant
    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);

    // Get tenant admin credentials for TB API
    const link = await prisma.userTenantLink.findFirstOrThrow({
      where: { tbTenantAdminUserId: ensured.tenantAdmin.tbTenantAdminUserId },
    });
    const password = decrypt(link.tbServicePasswordEnc);

    // Get tenant token for OTA upload
    const { tbTenantLogin } = await import("./tbTenant.js");
    const tbToken = await tbTenantLogin(userEmail, password, ensured.tenantAdmin.tbTenantAdminUserId);

    // Generate Arduino code
    const codeResult = generateArduinoCode(nodes, edges, config);

    if (!codeResult.validation.isValid) {
      return res.status(400).json({
        error: "Invalid graph",
        validation: codeResult.validation,
      });
    }

    // Create compile job record
    const compileJob = await prisma.compileJob.create({
      data: {
        status: "pending",
        deviceId,
        tenantId: ensured.tenant.id,
        logs: "Job queued",
      },
    });

    // Queue compilation job
    const bullJobId = await queueCompilationJob({
      jobId: compileJob.id,
      code: codeResult.code,
      boardType: "esp32:esp32:doit-devkit-v1",
      deviceId,
      version: version || "1.0.0",
      tbToken,
      tenantId: ensured.tenant.id,
    });

    res.json({
      success: true,
      jobId: compileJob.id,
      bullJobId,
      validation: codeResult.validation,
    });

  } catch (e: any) {
    console.error("Error starting compilation:", e);
    res.status(500).json({
      error: e?.message ?? "Failed to start compilation",
    });
  }
});

// Get compilation job status
app.get("/api/compile/:jobId/status", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing authentication headers" });
    }

    const { jobId } = req.params;

    // Get job from database
    const compileJob = await prisma.compileJob.findUnique({
      where: { id: jobId },
      include: { firmware: true },
    });

    if (!compileJob) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.json({
      success: true,
      job: {
        id: compileJob.id,
        status: compileJob.status,
        deviceId: compileJob.deviceId,
        logs: compileJob.logs,
        errorMsg: compileJob.errorMsg,
        firmware: compileJob.firmware,
        createdAt: compileJob.createdAt,
        updatedAt: compileJob.updatedAt,
      },
    });

  } catch (e: any) {
    console.error("Error fetching job status:", e);
    res.status(500).json({
      error: e?.message ?? "Failed to fetch job status",
    });
  }
});

// Get compilation logs
app.get("/api/compile/:jobId/logs", async (req, res) => {
  try {
    const { jobId } = req.params;

    const compileJob = await prisma.compileJob.findUnique({
      where: { id: jobId },
      select: { logs: true, errorMsg: true },
    });

    if (!compileJob) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.json({
      success: true,
      logs: compileJob.logs || "",
      error: compileJob.errorMsg,
    });

  } catch (e: any) {
    res.status(500).json({
      error: e?.message ?? "Failed to fetch logs",
    });
  }
});

// List user's compilation jobs
app.get("/api/compile/jobs", async (req, res) => {
  try {
    const userSub = req.header("x-user-sub");
    const userEmail = req.header("x-user-email");
    const userName = req.header("x-user-name") ?? undefined;

    if (!userSub || !userEmail) {
      return res.status(401).json({ error: "Missing authentication headers" });
    }

    const ensured = await ensureTenantForGoogleUser(userSub, userEmail, userName);

    const jobs = await prisma.compileJob.findMany({
      where: { tenantId: ensured.tenant.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { firmware: true },
    });

    res.json({ success: true, jobs });

  } catch (e: any) {
    res.status(500).json({
      error: e?.message ?? "Failed to fetch jobs",
    });
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(port, () => {
  console.log(`ThingsBoard proxy API listening on http://localhost:${port}`);
});
