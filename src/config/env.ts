import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

const repoRoot = process.cwd();
const envPath = path.join(repoRoot, ".env");
dotenv.config({ path: envPath });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().optional(),
  JWT_SECRET: z.string().min(16),
  VOICE_ACTIVE_TARGET: z.string().default("LIVEKIT_PRIMARY"),
  DB_ACTIVE_TARGET: z.string().default("NEON_PRIMARY"),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  LIVEKIT_HOST: z.string().optional(),
  ZEGOCLOUD_APP_ID: z.string().optional(),
  ZEGOCLOUD_SERVER_SECRET: z.string().optional(),
  AGORA_APP_ID: z.string().optional(),
  AGORA_APP_CERTIFICATE: z.string().optional(),
  MOCK_PAYMENT_AUTO_SUCCESS: z.string().default("true"),
  EXPOSE_INTERNAL_ERRORS: z.string().default("false"),
  ENABLE_DB_DIAGNOSTICS: z.string().default("false"),
  DB_DIAGNOSTIC_KEY: z.string().optional(),
  ADMIN_ID: z.string().min(1).optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
  CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:8081,http://localhost:19006")
});

export const env = envSchema.parse(process.env);
export const runtimeRepoRoot = repoRoot;
