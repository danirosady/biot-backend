import { Request, Response, NextFunction } from 'express';
import { JWTPayload } from './jwtUtils';
declare global {
    namespace Express {
        interface Request {
            user?: JWTPayload;
        }
    }
}
/**
 * Middleware to authenticate requests using JWT
 * Extracts user info from token and attaches to req.user
 */
export declare function authenticateToken(req: Request, res: Response, next: NextFunction): void;
/**
 * Optional authentication - doesn't fail if no token
 * Useful for endpoints that work with or without auth
 */
export declare function optionalAuth(req: Request, res: Response, next: NextFunction): void;
/**
 * Helper to extract user headers (for backwards compatibility)
 * Tries JWT first, falls back to x-user-* headers
 */
export declare function getUserFromRequest(req: Request): {
    sub: string;
    email: string;
    name?: string;
} | null;
//# sourceMappingURL=authMiddleware.d.ts.map