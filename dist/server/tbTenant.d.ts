export declare function tbTenantLogin(email: string, password: string, cacheKey: string): Promise<string>;
export declare function tenantListDevices(opts: {
    email: string;
    password: string;
    cacheKey: string;
    page?: number;
    pageSize?: number;
    type?: string;
}): Promise<{
    data: Array<any>;
    totalPages: number;
    totalElements: number;
    hasNext: boolean;
}>;
export declare function tenantCreateDevice(opts: {
    email: string;
    password: string;
    cacheKey: string;
    name: string;
    type?: string;
    label?: string;
    additionalInfo?: any;
}): Promise<any>;
export declare function tenantUpdateDevice(opts: {
    email: string;
    password: string;
    cacheKey: string;
    deviceId: string;
    name?: string;
    type?: string;
    label?: string;
    additionalInfo?: any;
}): Promise<any>;
export declare function tenantGetDeviceCredentials(opts: {
    email: string;
    password: string;
    cacheKey: string;
    deviceId: string;
}): Promise<any>;
export declare function tenantDeleteDevice(opts: {
    email: string;
    password: string;
    cacheKey: string;
    deviceId: string;
}): Promise<void>;
export declare function tenantGetDeviceInfo(opts: {
    email: string;
    password: string;
    cacheKey: string;
    deviceId: string;
}): Promise<any>;
//# sourceMappingURL=tbTenant.d.ts.map