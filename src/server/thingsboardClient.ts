import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();
import axios from "axios";

const rawBase = (process.env.THINGSBOARD_BASE_URL ?? "").trim();
if (!rawBase) {
  throw new Error("THINGSBOARD_BASE_URL is not set. Please set it in .env.local or .env");
}
const TB_BASE_URL = rawBase.replace(/\/+$/, "");

const TB_USER = (process.env.THINGSBOARD_TENANT_USERNAME ?? "").trim();
const TB_PASS = process.env.THINGSBOARD_TENANT_PASSWORD ?? "";

type TokenCache = {
  token: string | null;
  expiresAt: number; // epoch ms
};

const tokenCache: TokenCache = { token: null, expiresAt: 0 };

async function login(): Promise<string> {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 10_000) {
    return tokenCache.token;
  }
  try {
    const { data } = await axios.post(`${TB_BASE_URL}/api/auth/login`, {
      username: TB_USER,
      password: TB_PASS,
    });
    // Some TB setups return "token", others might use "accessToken"
    const token: string | undefined = data.token || data.accessToken;
    if (!token) {
      throw new Error("Login response missing token");
    }
    tokenCache.token = token;

    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
      tokenCache.expiresAt = (payload.exp ?? Math.floor(now / 1000) + 600) * 1000;
    } catch {
      tokenCache.expiresAt = now + 10 * 60 * 1000;
    }
    return tokenCache.token!;
  } catch (e: any) {
    tokenCache.token = null;
    tokenCache.expiresAt = 0;
    // Re-throw with original response so the route can pass through status/message
    const err: any = new Error(e?.message ?? "ThingsBoard login failed");
    err.response = e?.response;
    throw err;
  }
}

async function tbRequest<T>(config: { method: "GET" | "POST"; url: string; params?: any }) {
  const token = await login();
  const res = await axios.request<T>({
    method: config.method,
    url: `${TB_BASE_URL}${config.url}`,
    params: config.params,
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

export async function listDevices(page = 0, pageSize = 20, type?: string) {
  return tbRequest<{
    data: Array<any>;
    totalPages: number;
    totalElements: number;
    hasNext: boolean;
  }>({
    method: "GET",
    url: "/api/tenant/devices",
    params: { page, pageSize, type },
  });
}

export async function getDeviceInfo(deviceId: string) {
  return tbRequest<any>({ method: "GET", url: `/api/device/${deviceId}` });
}

export async function getAttributes(deviceId: string, scope: "SERVER_SCOPE" | "SHARED_SCOPE" | "CLIENT_SCOPE") {
  return tbRequest<any[]>({
    method: "GET",
    url: `/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes`,
    params: { scope },
  });
}

export async function getLatestTelemetry(deviceId: string, keys?: string) {
  return tbRequest<Record<string, Array<{ ts: number; value: any }>>>({
    method: "GET",
    url: `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`,
    params: { keys },
  });
}

// Add these new functions for sensor data integration
export async function sendTelemetry(deviceId: string, telemetryData: Record<string, any>) {
  const token = await login();
  const res = await axios.post(
    `${TB_BASE_URL}/api/v1/${deviceId}/telemetry`,
    telemetryData,
    {
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return res.data;
}

export async function getTelemetryHistory(
  deviceId: string, 
  keys: string[], 
  startTs: number, 
  endTs: number,
  interval?: number,
  limit?: number
) {
  return tbRequest<Record<string, Array<{ ts: number; value: any }>>>({
    method: "GET",
    url: `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`,
    params: { 
      keys: keys.join(','),
      startTs,
      endTs,
      interval,
      limit
    },
  });
}

export async function getAggregatedTelemetry(
  deviceId: string,
  keys: string[],
  startTs: number,
  endTs: number,
  interval: number,
  agg: 'MIN' | 'MAX' | 'AVG' | 'SUM' | 'COUNT'
) {
  return tbRequest<Record<string, Array<{ ts: number; value: any }>>>({
    method: "GET",
    url: `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`,
    params: {
      keys: keys.join(','),
      startTs,
      endTs,
      interval,
      agg
    },
  });
}

export async function deleteDeviceTelemetry(
  deviceId: string,
  keys: string[],
  deleteAllDataForKeys?: boolean
) {
  const token = await login();
  const params = new URLSearchParams();
  keys.forEach(key => params.append('keys', key));
  if (deleteAllDataForKeys) {
    params.append('deleteAllDataForKeys', 'true');
  }
  
  const res = await axios.delete(
    `${TB_BASE_URL}/api/plugins/telemetry/DEVICE/${deviceId}/timeseries/delete?${params}`,
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  return res.data;
}