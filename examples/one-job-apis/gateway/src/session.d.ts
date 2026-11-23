import "express-session";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    oauthCodeVerifier?: string;
    oauthState?: string;
    webauthnChallenge?: string;
  }
}