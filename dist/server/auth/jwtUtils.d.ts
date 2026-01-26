import { User } from '@prisma/client';
export interface JWTPayload {
    userId: string;
    email: string;
    name?: string;
    googleSub: string;
}
export interface TokenPair {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
}
/**
 * Generate access token and refresh token pair
 */
export declare function generateTokens(user: User): TokenPair;
/**
 * Verify and decode access token
 */
export declare function verifyAccessToken(token: string): JWTPayload | null;
/**
 * Verify refresh token
 */
export declare function verifyRefreshToken(token: string): {
    userId: string;
} | null;
/**
 * Extract token from Authorization header
 */
export declare function extractTokenFromHeader(authHeader?: string): string | null;
//# sourceMappingURL=jwtUtils.d.ts.map