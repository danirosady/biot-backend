export declare function saCreateTenant(title: string): Promise<{
    id: {
        id: string;
    };
}>;
export declare function saCreateTenantAdmin(tenantId: string, email: string, firstName?: string, lastName?: string): Promise<{
    id: {
        id: string;
    };
}>;
export declare function saGetActivationLink(userId: string): Promise<string>;
export declare function noauthActivate(activateToken: string, password: string): Promise<void>;
export declare function extractActivateTokenFromLink(link: string): string | null;
//# sourceMappingURL=tbSysAdmin.d.ts.map