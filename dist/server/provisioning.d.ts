export declare function ensureTenantForGoogleUser(googleSub: string, email: string, name?: string): Promise<{
    user: {
        id: string;
        googleSub: string;
        email: string;
        name: string | null;
        createdAt: Date;
        updatedAt: Date;
    };
    tenant: {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tbTenantId: string;
        title: string;
    };
    tenantAdmin: {
        tbTenantAdminUserId: string;
        password: string;
    };
}>;
//# sourceMappingURL=provisioning.d.ts.map