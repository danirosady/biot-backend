import axios from "axios";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

const rawBase = (process.env.THINGSBOARD_BASE_URL ?? "").trim();
if (!rawBase) throw new Error("THINGSBOARD_BASE_URL is not set");
const TB_BASE_URL = rawBase.replace(/\/+$/, "");

type TokenCache = { token: string | null; expiresAt: number };
const tokenCacheByUserId = new Map<string, TokenCache>();

export async function tbTenantLogin(email: string, password: string, cacheKey: string): Promise<string> {
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

export async function tenantListDevices(opts: { email: string; password: string; cacheKey: string; page?: number; pageSize?: number; type?: string; }) {
  const token = await tbTenantLogin(opts.email, opts.password, opts.cacheKey);
  return tenantRequest<{
    data: Array<any>;
    totalPages: number;
    totalElements: number;
    hasNext: boolean;
  }>({
    method: "GET",
    url: "/api/tenant/devices",
    params: { page: opts.page ?? 0, pageSize: opts.pageSize ?? 20, type: opts.type },
  }, token);
}

// New: create device as tenant admin
export async function tenantCreateDevice(opts: {
  email: string;
  password: string;
  cacheKey: string;
  name: string;
  type?: string;
  label?: string;
  additionalInfo?: any;
}) {
  const token = await tbTenantLogin(opts.email, opts.password, opts.cacheKey);
  return tenantRequest<any>(
    {
      method: "POST",
      url: "/api/device",
      data: {
        name: opts.name,
        type: opts.type,
        label: opts.label,
        additionalInfo: opts.additionalInfo,
      },
    },
    token
  );
}

// New: update device as tenant admin (ThingsBoard uses POST /api/device with id to update)
export async function tenantUpdateDevice(opts: {
  email: string;
  password: string;
  cacheKey: string;
  deviceId: string;
  name?: string;
  type?: string;
  label?: string;
  additionalInfo?: any;
}) {
  const token = await tbTenantLogin(opts.email, opts.password, opts.cacheKey);
  return tenantRequest<any>(
    {
      method: "POST",
      url: "/api/device",
      data: {
        id: { id: opts.deviceId, entityType: "DEVICE" },
        name: opts.name,
        type: opts.type,
        label: opts.label,
        additionalInfo: opts.additionalInfo,
      },
    },
    token
  );
}

// New: get device credentials
export async function tenantGetDeviceCredentials(opts: {
  email: string;
  password: string;
  cacheKey: string;
  deviceId: string;
}) {
  const token = await tbTenantLogin(opts.email, opts.password, opts.cacheKey);
  return tenantRequest<any>(
    { method: "GET", url: `/api/device/${opts.deviceId}/credentials` },
    token
  );
}

// New: delete device
export async function tenantDeleteDevice(opts: {
  email: string;
  password: string;
  cacheKey: string;
  deviceId: string;
}) {
  const token = await tbTenantLogin(opts.email, opts.password, opts.cacheKey);
  return tenantRequest<void>(
    { method: "DELETE", url: `/api/device/${opts.deviceId}` },
    token
  );
}

// Get device info as tenant admin
export async function tenantGetDeviceInfo(opts: {
  email: string;
  password: string;
  cacheKey: string;
  deviceId: string;
}) {
  const token = await tbTenantLogin(opts.email, opts.password, opts.cacheKey);
  return tenantRequest<any>(
    { method: "GET", url: `/api/device/${opts.deviceId}` },
    token
  );
}