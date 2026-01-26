export interface GoogleUserInfo {
    sub: string;
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
export declare function verifyGoogleToken(idToken: string): Promise<GoogleUserInfo>;
/**
 * Validate that the email is verified
 */
export declare function validateEmailVerified(userInfo: GoogleUserInfo): void;
//# sourceMappingURL=googleOAuth.d.ts.map