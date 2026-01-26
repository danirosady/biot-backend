import { Request, Response, NextFunction } from 'express';
import { extractTokenFromHeader, verifyAccessToken, JWTPayload } from './jwtUtils';

// Extend Express Request to include user
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
export function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  const token = extractTokenFromHeader(authHeader);

  if (!token) {
    res.status(401).json({ error: 'Missing authentication token' });
    return;
  }

  const payload = verifyAccessToken(token);

  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // Attach user to request
  req.user = payload;
  next();
}

/**
 * Optional authentication - doesn't fail if no token
 * Useful for endpoints that work with or without auth
 */
export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  const token = extractTokenFromHeader(authHeader);

  if (token) {
    const payload = verifyAccessToken(token);
    if (payload) {
      req.user = payload;
    }
  }

  next();
}

/**
 * Helper to extract user headers (for backwards compatibility)
 * Tries JWT first, falls back to x-user-* headers
 */
export function getUserFromRequest(req: Request): {
  sub: string;
  email: string;
  name?: string;
} | null {
  // Try JWT user first
  if (req.user) {
    return {
      sub: req.user.googleSub,
      email: req.user.email,
      name: req.user.name,
    };
  }

  // Fall back to headers (for backwards compatibility)
  const sub = req.header('x-user-sub');
  const email = req.header('x-user-email');
  const name = req.header('x-user-name');

  if (sub && email) {
    return { sub, email, name };
  }

  return null;
}
