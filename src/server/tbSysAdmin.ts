import axios from "axios";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

const rawBase = (process.env.THINGSBOARD_BASE_URL ?? "").trim();
if (!rawBase) throw new Error("THINGSBOARD_BASE_URL is not set");
const TB_BASE_URL = rawBase.replace(/\/+$/, "");

const SA_USER = (process.env.THINGSBOARD_SYSADMIN_USERNAME ?? "").trim();
const SA_PASS = process.env.THINGSBOARD_SYSADMIN_PASSWORD ?? "";

type TokenCache = { token: string | null; expiresAt: number };
const saTokenCache: TokenCache = { token: null, expiresAt: 0 };

async function sysAdminLogin(): Promise<string> {
  const now = Date.now();
  if (saTokenCache.token && now < saTokenCache.expiresAt - 10_000) return saTokenCache.token!;
  const { data } = await axios.post(`${TB_BASE_URL}/api/auth/login`, { username: SA_USER, password: SA_PASS });
  const token: string = data.token || data.accessToken;
  if (!token) throw new Error("SysAdmin login response missing token");
  saTokenCache.token = token;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    saTokenCache.expiresAt = (payload.exp ?? Math.floor(now / 1000) + 600) * 1000;
  } catch {
    saTokenCache.expiresAt = now + 10 * 60 * 1000;
  }
  return saTokenCache.token!;
}

async function saRequest<T>(cfg: { method: "GET" | "POST" | "DELETE"; url: string; params?: any; data?: any }) {
  const token = await sysAdminLogin();
  const res = await axios.request<T>({
    method: cfg.method,
    url: `${TB_BASE_URL}${cfg.url}`,
    params: cfg.params,
    data: cfg.data,
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

export async function saCreateTenant(title: string) {
  return saRequest<{ id: { id: string } }>({
    method: "POST",
    url: "/api/tenant",
    data: { title },
  });
}

export async function saCreateTenantAdmin(tenantId: string, email: string, firstName?: string, lastName?: string) {
  // sendActivationMail=false to avoid email; we will activate programmatically //TODO 
  return saRequest<{ id: { id: string } }>({
    method: "POST",
    url: "/api/user",
    params: { sendActivationMail: false },
    data: {
      email,
      firstName,
      lastName,
      authority: "TENANT_ADMIN",
      tenantId: { entityType: "TENANT", id: tenantId },
    },
  });
}

export async function saGetActivationLink(userId: string): Promise<string> {
  // Returns a full URL with activateToken query param
  return saRequest<string>({ method: "GET", url: `/api/user/${userId}/activationLink` });
}

export async function noauthActivate(activateToken: string, password: string) {
  // Complete activation without email using activateToken and desired password
  // POST /api/noauth/activate with { activateToken, password }
  await axios.post(`${TB_BASE_URL}/api/noauth/activate`, { activateToken, password });
}

export function extractActivateTokenFromLink(link: string): string | null {
  try {
    const url = new URL(link);
    return url.searchParams.get("activateToken");
  } catch {
    return null;
  }
}