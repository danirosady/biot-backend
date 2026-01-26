import { prisma } from "./prisma";
import { encrypt, decrypt } from "./crypto";
import { saCreateTenant, saCreateTenantAdmin, saGetActivationLink, noauthActivate, extractActivateTokenFromLink } from "./tbSysAdmin";

export async function ensureTenantForGoogleUser(googleSub: string, email: string, name?: string) {
  // 1) Find existing user by email or googleSub
  let user = await prisma.user.findFirst({
    where: {
      OR: [
        { googleSub },
        { email },
      ],
    },
  });

  if (user) {
    // Update existing user with latest info
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        googleSub, // Update googleSub in case it changed
        email,
        name,
      },
    });
  } else {
    // Create new user
    user = await prisma.user.create({
      data: {
        googleSub,
        email,
        name,
      },
    });
  }

  const existingLinks = await prisma.userTenantLink.findMany({
    where: { userId: user.id },
    include: { tenant: true },
  });

  if (existingLinks.length > 0) {
    const link = existingLinks[0];
    return {
      user,
      tenant: link.tenant,
      tenantAdmin: { tbTenantAdminUserId: link.tbTenantAdminUserId, password: decrypt(link.tbServicePasswordEnc) },
    };
  }

  // 2) Create TB tenant and tenant admin via SysAdmin
  const tenantTitle = name ? `${name}'s tenant` : `Tenant ${email}`;
  const tenantResp = await saCreateTenant(tenantTitle);
  const tbTenantId = tenantResp.id.id;

  const [firstName, ...rest] = (name ?? "").split(" ");
  const lastName = rest.join(" ") || undefined;
  const adminResp = await saCreateTenantAdmin(tbTenantId, email, firstName, lastName);
  const tbTenantAdminUserId = adminResp.id.id;

  // 3) Get activation link and complete activation with a generated strong password
  const activationLink = await saGetActivationLink(tbTenantAdminUserId);
  const activateToken = extractActivateTokenFromLink(activationLink);
  if (!activateToken) throw new Error("Failed to parse activateToken from ThingsBoard activation link");
  // Generate strong password
  const generatedPassword = `Adm!n-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await noauthActivate(activateToken, generatedPassword);

  // 4) Persist tenant + link
  const tenant = await prisma.tenant.create({
    data: { tbTenantId, title: tenantTitle },
  });

  const link = await prisma.userTenantLink.create({
    data: {
      userId: user.id,
      tenantId: tenant.id,
      tbTenantAdminUserId,
      tbServicePasswordEnc: encrypt(generatedPassword),
    },
  });

  return {
    user,
    tenant,
    tenantAdmin: { tbTenantAdminUserId, password: generatedPassword },
  };
}