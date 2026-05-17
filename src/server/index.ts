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
import { tenantCreateDevice, tenantDeleteDevice, tenantGetDeviceCredentials, tenantGetDeviceInfo, tenantListDevices, tenantSendRpcCommand, tenantUpdateDevice } from "./tbTenant";
import { getAggregatedTelemetry, getAttributes, getDeviceInfo, getLatestTelemetry, getTelemetryHistory } from "./thingsboardClient";
import { generateArduinoCode, extractDeviceConfig } from "../transpiler/codeGenerator";
import { queueCompilationJob } from "../workers/buildQueue";
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
app.use(optionalAuth);

// Backward compatibility bridge: older routes still read x-user-* headers.
app.use((req, _res, next) => {
  if (req.user) {
    req.headers["x-user-sub"] = req.headers["x-user-sub"] ?? req.user.googleSub;
    req.headers["x-user-email"] = req.headers["x-user-email"] ?? req.user.email;
    if (req.user.name) {
      req.headers["x-user-name"] = req.headers["x-user-name"] ?? req.user.name;
    }
  }
  next();
});

type TimeseriesPoint = { ts: number; value: unknown };

function parseQueryString(input: unknown): string | undefined {
  if (Array.isArray(input)) {
    const first = input[0];
    return typeof first === "string" ? first : undefined;
  }
  return typeof input === "string" ? input : undefined;
}

function parseTelemetryValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const asNumber = Number(trimmed);
  return Number.isNaN(asNumber) ? value : asNumber;
}

function normalizeTelemetryRows(
  deviceId: string,
  raw: Record<string, TimeseriesPoint[]>
): Array<Record<string, unknown>> {
  const rowsByTs = new Map<number, Record<string, unknown>>();

  Object.entries(raw ?? {}).forEach(([key, points]) => {
    if (!Array.isArray(points)) return;
    points.forEach((point) => {
      const ts = Number(point?.ts);
      if (!Number.isFinite(ts)) return;
      const existing = rowsByTs.get(ts) ?? { timestamp: ts, deviceId };
      existing[key] = parseTelemetryValue(point?.value);
      rowsByTs.set(ts, existing);
    });
  });

  return Array.from(rowsByTs.values()).sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

function mapCompileStatusForFrontend(status: string): "pending" | "processing" | "completed" | "failed" {
  switch (status) {
    case "success":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    default:
      return "processing";
  }
}

function mapCompileProgressForFrontend(status: string): number {
  switch (status) {
    case "pending":
      return 5;
    case "compiling":
      return 45;
    case "uploading":
      return 80;
    case "success":
      return 100;
    case "failed":
      return 100;
    default:
      return 20;
  }
}

const LEGACY_FQBN_ALIASES: Record<string, string> = {
  "esp32:esp32:doit-devkit-v1": "esp32:esp32:esp32doit-devkit-v1",
};

function normalizeFqbn(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const fqbn = input.trim();
  if (!fqbn) return null;
  return LEGACY_FQBN_ALIASES[fqbn] ?? fqbn;
}

function resolveCompileFqbn(payload: any): string {
  const candidates = [
    payload?.boardType,
    payload?.fqbn,
    payload?.config?.boardType,
    payload?.config?.fqbn,
    process.env.ARDUINO_DEFAULT_FQBN,
    "esp32:esp32:esp32",
  ];

  for (const candidate of candidates) {
    const resolved = normalizeFqbn(candidate);
    if (resolved) return resolved;
  }

  return "esp32:esp32:esp32";
}

function resolveFirmwareVersion(input: unknown): string {
  const base = typeof input === "string" && input.trim().length > 0 ? input.trim() : "1.0.0";
  // Keep OTA version unique per deploy to avoid ThingsBoard title+version collision.
  return `${base}-${Date.now()}`;
}

const userSettingsStore = new Map<string, any>();

function getDefaultUserSettings(user: { id: string; email: string; name?: string | null }) {
  return {
    userId: user.id,
    email: user.email,
    name: user.name ?? "",
    notifications: {
      email: true,
      browser: true,
      deviceAlerts: true,
      systemUpdates: false,
    },
    preferences: {
      theme: "light",
      language: "en",
      timezone: "UTC",
      dateFormat: "MM/DD/YYYY",
      temperatureUnit: "celsius",
    },
    privacy: {
      dataRetentionDays: 90,
      shareAnalytics: false,
    },
  };
}

async function resolveSensorTypeId(input: {
  sensorTypeId?: unknown;
  type?: unknown;
  sensorTypeName?: unknown;
}): Promise<string | null> {
  const candidates = [input.sensorTypeId, input.type, input.sensorTypeName]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());

  for (const candidate of candidates) {
    const byId = await prisma.sensorType.findUnique({
      where: { id: candidate },
      select: { id: true },
    });
    if (byId) return byId.id;

    const byName = await prisma.sensorType.findUnique({
      where: { name: candidate },
      select: { id: true },
    });
    if (byName) return byName.id;
  }

  return null;
}

function toFrontendSensor(sensor: any) {
  const pinConfig = sensor.pinMapping && typeof sensor.pinMapping === "object" ? sensor.pinMapping : {};
  const outputConfig = sensor.outputConfig && typeof sensor.outputConfig === "object" ? sensor.outputConfig : {};
  const sensorTypeName = sensor.sensorType?.name ?? sensor.sensorTypeId;

  return {
    id: sensor.id,
    name: sensor.name,
    type: sensorTypeName,
    deviceId: sensor.deviceId,
    label: sensor.deviceName ?? "",
    additionalInfo: {
      sensorType: sensorTypeName,
      pinConfig,
      outputFormat: sensor.outputTemplate ?? "json",
      enabled: sensor.isActive !== false,
      outputConfig,
    },
    createdTime: sensor.createdAt ? new Date(sensor.createdAt).getTime() : undefined,
  };
}

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

// Update authenticated user profile
app.put("/api/auth/profile", authenticateToken, async (req, res) => {
  try {
    const { name } = req.body ?? {};
    const userId = req.user!.userId;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(typeof name === "string" ? { name: name.trim() } : {}),
      },
    });

    const existingSettings = userSettingsStore.get(userId);
    if (existingSettings) {
      userSettingsStore.set(userId, { ...existingSettings, name: updatedUser.name ?? "" });
    }

    res.json({
      success: true,
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        name: updatedUser.name,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Failed to update profile" });
  }
});

// Google-auth users do not use local passwords in this backend.
app.post("/api/auth/change-password", authenticateToken, async (_req, res) => {
  res.status(400).json({
    message: "Password change is not available for Google-authenticated accounts.",
  });
});

app.post("/api/auth/delete-account", authenticateToken, async (_req, res) => {
  res.status(400).json({
    message: "Account deletion is disabled from API. Please contact administrator.",
  });
});

app.get("/api/settings", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    const stored = userSettingsStore.get(user.id);
    const defaults = getDefaultUserSettings(user);
    const settings = stored
      ? { ...defaults, ...stored, userId: user.id, email: user.email, name: user.name ?? stored.name ?? "" }
      : defaults;

    if (!stored) userSettingsStore.set(user.id, settings);
    res.json(settings);
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Failed to fetch settings" });
  }
});

app.put("/api/settings", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    const defaults = getDefaultUserSettings(user);
    const current = userSettingsStore.get(user.id) ?? defaults;
    const payload = req.body ?? {};

    const next = {
      ...current,
      notifications: { ...current.notifications, ...(payload.notifications ?? {}) },
      preferences: { ...current.preferences, ...(payload.preferences ?? {}) },
      privacy: { ...current.privacy, ...(payload.privacy ?? {}) },
      userId: user.id,
      email: user.email,
      name: user.name ?? current.name ?? "",
    };

    userSettingsStore.set(user.id, next);
    res.json(next);
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Failed to update settings" });
  }
});

app.get("/api/settings/export", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    const settings = userSettingsStore.get(user.id) ?? getDefaultUserSettings(user);
    const exportPayload = {
      generatedAt: new Date().toISOString(),
      user: { id: user.id, email: user.email, name: user.name },
      settings,
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename=\"user-data-${Date.now()}.json\"`);
    res.send(JSON.stringify(exportPayload, null, 2));
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Failed to export data" });
  }
});

app.get("/api/settings/activity", authenticateToken, async (req, res) => {
  try {
    const limitRaw = parseQueryString(req.query.limit);
    const limit = Math.max(1, Math.min(100, Number(limitRaw ?? 20) || 20));

    const ensured = await ensureTenantForGoogleUser(req.user!.googleSub, req.user!.email, req.user!.name);
    const jobs = await prisma.compileJob.findMany({
      where: { tenantId: ensured.tenant.id },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        status: true,
        deviceId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const activities = jobs.map((job) => ({
      id: job.id,
      timestamp: job.updatedAt.getTime(),
      action: "Compile Job",
      description: `Device ${job.deviceId}: ${job.status}`,
    }));

    res.json({ activities });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Failed to fetch activity" });
  }
});

app.get("/api/logs", authenticateToken, async (_req, res) => {
  res.json({ logs: [] });
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

// Get device credentials as tenant admin
app.get("/api/devices/:id/credentials", authenticateToken, async (req, res) => {
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

    const credentials = await tenantGetDeviceCredentials({
      email: userInfo.email,
      password,
      cacheKey: ensured.tenantAdmin.tbTenantAdminUserId,
      deviceId: id,
    });

    res.json(credentials);
  } catch (e: any) {
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Send RPC command as tenant admin
app.post("/api/devices/:id/rpc", authenticateToken, async (req, res) => {
  try {
    const userInfo = getUserFromRequest(req);
    if (!userInfo) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { id } = req.params;
    const { method, params } = req.body ?? {};
    if (!id) return res.status(400).json({ error: "Device id is required" });
    if (!method || typeof method !== "string") {
      return res.status(400).json({ error: "RPC method is required" });
    }

    const ensured = await ensureTenantForGoogleUser(userInfo.sub, userInfo.email, userInfo.name);
    const link = await prisma.userTenantLink.findFirstOrThrow({
      where: { tbTenantAdminUserId: ensured.tenantAdmin.tbTenantAdminUserId },
    });
    const password = decrypt(link.tbServicePasswordEnc);

    const result = await tenantSendRpcCommand({
      email: userInfo.email,
      password,
      cacheKey: ensured.tenantAdmin.tbTenantAdminUserId,
      deviceId: id,
      method,
      params,
    });

    res.json({ success: true, result });
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
      data: sensors.map(toFrontendSensor),
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

    const { name, deviceId, deviceName, label, sensorTypeId, type, pinConfiguration, pinMapping, outputConfiguration, outputConfig, outputTemplate, isActive, additionalInfo } = req.body ?? {};
    const resolvedSensorTypeId = await resolveSensorTypeId({
      sensorTypeId,
      type,
      sensorTypeName: additionalInfo?.sensorType,
    });

    if (!name || !deviceId || !resolvedSensorTypeId) {
      return res.status(400).json({ error: "Name, deviceId, and sensor type are required" });
    }

    const ensured = await ensureTenantForGoogleUser(userInfo.sub, userInfo.email, userInfo.name);

    const sensor = await prisma.sensor.create({
      data: {
        name,
        deviceId,
        deviceName: deviceName || label || String(deviceId),
        sensorTypeId: resolvedSensorTypeId,
        pinMapping: pinConfiguration || pinMapping || additionalInfo?.pinConfig || {},
        outputConfig: outputConfiguration || outputConfig || additionalInfo?.outputConfig || {},
        outputTemplate: outputTemplate || additionalInfo?.outputFormat || null,
        isActive: isActive ?? additionalInfo?.enabled ?? true,
        tenantId: ensured.tenant.id
      },
      include: { 
        sensorType: { include: { outputs: true } }
      }
    });
    
    res.json({ sensor: toFrontendSensor(sensor) });
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
    const {
      name,
      deviceId,
      deviceName,
      label,
      sensorTypeId,
      type,
      pinMapping,
      pinConfiguration,
      outputConfig,
      outputConfiguration,
      outputTemplate,
      isActive,
      additionalInfo,
    } = req.body ?? {};
    
    const ensured = await ensureTenantForGoogleUser(userInfo.sub, userInfo.email, userInfo.name);

    // Build update data object with only provided fields
    const updateData: any = {};
    const resolvedSensorTypeId = await resolveSensorTypeId({
      sensorTypeId,
      type,
      sensorTypeName: additionalInfo?.sensorType,
    });

    if (name !== undefined) updateData.name = name;
    if (deviceId !== undefined) updateData.deviceId = deviceId;
    if (deviceName !== undefined || label !== undefined) updateData.deviceName = deviceName ?? label;
    if (resolvedSensorTypeId) updateData.sensorTypeId = resolvedSensorTypeId;

    const resolvedPinMapping = pinMapping ?? pinConfiguration ?? additionalInfo?.pinConfig;
    if (resolvedPinMapping !== undefined) updateData.pinMapping = resolvedPinMapping;

    const resolvedOutputConfig = outputConfig ?? outputConfiguration ?? additionalInfo?.outputConfig;
    if (resolvedOutputConfig !== undefined) updateData.outputConfig = resolvedOutputConfig;

    const resolvedOutputTemplate = outputTemplate ?? additionalInfo?.outputFormat;
    if (resolvedOutputTemplate !== undefined) updateData.outputTemplate = resolvedOutputTemplate;

    if (isActive !== undefined) {
      updateData.isActive = isActive;
    } else if (additionalInfo?.enabled !== undefined) {
      updateData.isActive = additionalInfo.enabled;
    }

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
    
    res.json({ sensor: toFrontendSensor(sensor) });
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

app.get("/api/sensors/:id/details", authenticateToken, async (req, res) => {
  try {
    const userInfo = getUserFromRequest(req);
    if (!userInfo) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Sensor id is required" });

    const ensured = await ensureTenantForGoogleUser(userInfo.sub, userInfo.email, userInfo.name);
    const sensor = await prisma.sensor.findFirst({
      where: {
        id,
        tenantId: ensured.tenant.id,
      },
      include: {
        sensorType: { include: { outputs: true } },
      },
    });

    if (!sensor) {
      return res.status(404).json({ error: "Sensor not found" });
    }

    res.json(toFrontendSensor(sensor));
  } catch (e: any) {
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
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

// Compatibility endpoint for frontend telemetry API:
// supports /api/telemetry?deviceId=...&startTime=...&endTime=...
app.get("/api/telemetry", async (req, res) => {
  try {
    const userInfo = getUserFromRequest(req);
    if (!userInfo) {
      return res.status(401).json({ error: "Missing authentication headers" });
    }

    const startTs = Number(parseQueryString(req.query.startTs) ?? parseQueryString(req.query.startTime) ?? Date.now() - 24 * 60 * 60 * 1000);
    const endTs = Number(parseQueryString(req.query.endTs) ?? parseQueryString(req.query.endTime) ?? Date.now());
    const keysCsv = parseQueryString(req.query.keys) ?? "temperature,humidity";
    const intervalRaw = parseQueryString(req.query.interval);
    const aggRaw = parseQueryString(req.query.agg) ?? parseQueryString(req.query.aggregation);

    const deviceIdValues = req.query.deviceId;
    const deviceIds: string[] = [];
    if (Array.isArray(deviceIdValues)) {
      deviceIdValues.forEach((id) => {
        if (typeof id === "string" && id.trim()) deviceIds.push(id.trim());
      });
    } else if (typeof deviceIdValues === "string" && deviceIdValues.trim()) {
      deviceIds.push(deviceIdValues.trim());
    }
    const deviceIdsCsv = parseQueryString(req.query.deviceIds);
    if (deviceIdsCsv) {
      deviceIdsCsv.split(",").map((v) => v.trim()).filter(Boolean).forEach((id) => deviceIds.push(id));
    }

    if (deviceIds.length === 0) {
      return res.json({ data: [] });
    }

    const keys = keysCsv.split(",").map((k) => k.trim()).filter(Boolean);
    const interval = intervalRaw ? Number(intervalRaw) : undefined;
    const agg = aggRaw ? aggRaw.toUpperCase() : undefined;

    const rowsPerDevice = await Promise.all(
      deviceIds.map(async (deviceId) => {
        const raw = interval && agg
          ? await getAggregatedTelemetry(
              deviceId,
              keys,
              startTs,
              endTs,
              interval,
              agg as "MIN" | "MAX" | "AVG" | "SUM" | "COUNT"
            )
          : await getTelemetryHistory(deviceId, keys, startTs, endTs);
        return normalizeTelemetryRows(deviceId, raw);
      })
    );

    const data = rowsPerDevice.flat().sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    res.json({ data });
  } catch (e: any) {
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

// Compatibility endpoint for dashboard chart API:
// /api/telemetry/:deviceId/history?startTime=...&endTime=...&keys=...
app.get("/api/telemetry/:deviceId/history", async (req, res) => {
  try {
    const userInfo = getUserFromRequest(req);
    if (!userInfo) {
      return res.status(401).json({ error: "Missing authentication headers" });
    }

    const { deviceId } = req.params;
    const startTs = Number(parseQueryString(req.query.startTs) ?? parseQueryString(req.query.startTime) ?? Date.now() - 24 * 60 * 60 * 1000);
    const endTs = Number(parseQueryString(req.query.endTs) ?? parseQueryString(req.query.endTime) ?? Date.now());
    const keysCsv = parseQueryString(req.query.keys) ?? "temperature,humidity";
    const intervalRaw = parseQueryString(req.query.interval);
    const aggRaw = parseQueryString(req.query.agg) ?? parseQueryString(req.query.aggregation);

    const keys = keysCsv.split(",").map((k) => k.trim()).filter(Boolean);
    const interval = intervalRaw ? Number(intervalRaw) : undefined;
    const agg = aggRaw ? aggRaw.toUpperCase() : undefined;

    const raw = interval && agg
      ? await getAggregatedTelemetry(
          deviceId,
          keys,
          startTs,
          endTs,
          interval,
          agg as "MIN" | "MAX" | "AVG" | "SUM" | "COUNT"
        )
      : await getTelemetryHistory(deviceId, keys, startTs, endTs);

    res.json({ data: normalizeTelemetryRows(deviceId, raw) });
  } catch (e: any) {
    const status = e?.response?.status ?? 500;
    const body = e?.response?.data ?? { error: e?.message ?? "Unknown error" };
    res.status(status).json(body);
  }
});

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
    const userInfo = getUserFromRequest(req);
    if (!userInfo) {
      return res.status(401).json({ error: "Missing authentication headers" });
    }

    const { deviceId, keys, interval } = req.query;
    const startTs = parseQueryString(req.query.startTs) ?? parseQueryString(req.query.startTime);
    const endTs = parseQueryString(req.query.endTs) ?? parseQueryString(req.query.endTime);
    const agg = parseQueryString(req.query.agg) ?? parseQueryString(req.query.aggregation);
    
    if (!deviceId || !keys || !startTs || !endTs) {
      return res.status(400).json({ error: "Missing required parameters: deviceId, keys, startTs, endTs" });
    }

    await ensureTenantForGoogleUser(userInfo.sub, userInfo.email, userInfo.name);
    
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
    const userInfo = getUserFromRequest(req);
    if (!userInfo) {
      return res.status(401).json({ error: "Missing authentication headers" });
    }

    const { keys, startTs, endTs, interval, agg, deviceIds } = req.query;
    
    if (!keys || !startTs || !endTs || !interval || !agg) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    const ensured = await ensureTenantForGoogleUser(userInfo.sub, userInfo.email, userInfo.name);
    
    // Get tenant credentials
    const link = await prisma.userTenantLink.findFirstOrThrow({
      where: { tbTenantAdminUserId: ensured.tenantAdmin.tbTenantAdminUserId },
    });
    const password = decrypt(link.tbServicePasswordEnc);
    
    // Use tenant-specific device listing
    const devices = await tenantListDevices({
      email: userInfo.email,
      password,
      cacheKey: ensured.tenantAdmin.tbTenantAdminUserId,
      page: 0,
      pageSize: 100
    });
    
    console.log(`Found ${devices.data.length} devices for tenant ${userInfo.email}`);
    
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
    const token = await tenantLogin(userInfo.email, password, ensured.tenantAdmin.tbTenantAdminUserId);
    
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
    const userInfo = getUserFromRequest(req);
    if (!userInfo) {
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
    const ensured = await ensureTenantForGoogleUser(userInfo.sub, userInfo.email, userInfo.name);

    // Get tenant admin credentials for TB API
    const link = await prisma.userTenantLink.findFirstOrThrow({
      where: { tbTenantAdminUserId: ensured.tenantAdmin.tbTenantAdminUserId },
    });
    const password = decrypt(link.tbServicePasswordEnc);

    // Get tenant token for OTA upload
    const { tbTenantLogin } = await import("./tbTenant.js");
    const tbToken = await tbTenantLogin(userInfo.email, password, ensured.tenantAdmin.tbTenantAdminUserId);

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

    const boardType = resolveCompileFqbn(req.body);

    const firmwareVersion = resolveFirmwareVersion(version);

    // Queue compilation job
    const bullJobId = await queueCompilationJob({
      jobId: compileJob.id,
      code: codeResult.code,
      boardType,
      deviceId,
      version: firmwareVersion,
      tbToken,
      tenantId: ensured.tenant.id,
    });

    res.json({
      success: true,
      job: {
        id: compileJob.id,
        status: "pending",
        progress: 5,
        logs: compileJob.logs,
        error: null,
        deviceId: compileJob.deviceId,
      },
      jobId: compileJob.id,
      bullJobId,
      version: firmwareVersion,
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
    const userInfo = getUserFromRequest(req);
    if (!userInfo) {
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
        status: mapCompileStatusForFrontend(compileJob.status),
        rawStatus: compileJob.status,
        progress: mapCompileProgressForFrontend(compileJob.status),
        deviceId: compileJob.deviceId,
        logs: compileJob.logs,
        error: compileJob.errorMsg,
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
