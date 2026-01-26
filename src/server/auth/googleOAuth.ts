import { OAuth2Client } from 'google-auth-library';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

if (!GOOGLE_CLIENT_ID) {
  console.warn('GOOGLE_CLIENT_ID not set. Google OAuth will not work.');
}

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

export interface GoogleUserInfo {
  sub: string;      // Google user ID
  email: string;
  name?: string;
  picture?: string;
  email_verified: boolean;
}

/**
 * Verify Google ID token and extract user info
 * @param idToken - Google ID token from frontend
 * @returns User information from Google
 */
export async function verifyGoogleToken(idToken: string): Promise<GoogleUserInfo> {
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    
    if (!payload) {
      throw new Error('Invalid token payload');
    }
    
    if (!payload.sub || !payload.email) {
      throw new Error('Missing required fields in token');
    }
    
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      email_verified: payload.email_verified || false,
    };
  } catch (error: any) {
    console.error('Google token verification failed:', error.message);
    throw new Error(`Invalid Google token: ${error.message}`);
  }
}

/**
 * Validate that the email is verified
 */
export function validateEmailVerified(userInfo: GoogleUserInfo): void {
  if (!userInfo.email_verified) {
    throw new Error('Email not verified. Please verify your email with Google.');
  }
}
