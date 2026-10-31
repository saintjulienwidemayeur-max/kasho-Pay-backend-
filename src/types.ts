// Shared types of the API handlers (kept apart so routes.ts and admin.ts can both import them without a cycle).
import type { z } from "zod";

export type Ctx = {
  userId: string; email: string; ip: string | null; ua: string | null; token?: string;
  /** The user has a verified TOTP factor. */ mfa?: boolean;
  /** Assurance level of the access token ("aal2" = 2FA code passed in this session). */ aal?: "aal1" | "aal2";
};
export type Handler = { schema: z.ZodTypeAny; run: (d: any, c: Ctx) => Promise<unknown> };
