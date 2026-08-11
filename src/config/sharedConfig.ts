import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const appConfigSchema = z.object({
  app: z.object({
    name: z.string(),
    supportEmail: z.string().email(),
    defaultLanguage: z.string()
  }),
  pages: z.array(z.string()),
  tabs: z.array(z.string()),
  voice: z.object({
    defaultProvider: z.string(),
    minimumBalanceCoins: z.number().int().min(0),
    coinChargePerMinute: z.number().int().min(1)
  }),
  database: z.object({
    defaultProvider: z.string()
  }),
  payments: z.object({
    activeGateway: z.string(),
    availableGateways: z.array(z.string()),
    topupPackages: z.array(z.number().int().positive())
  }),
  featureFlags: z.record(z.boolean()),
  languages: z.array(z.string()),
  policies: z.object({
    terms: z.string(),
    privacy: z.string(),
    faqs: z.array(z.object({ q: z.string(), a: z.string() }))
  })
});

const poolEntry = z.object({
  enabled: z.boolean(),
  status: z.string(),
  priority: z.number().int().min(1)
});

const voicePoolEntry = poolEntry.extend({
  monthly_limit_minutes: z.number().int().nonnegative(),
  current_used_minutes: z.number().int().nonnegative()
});

const failoverSchema = z.object({
  databases: z.object({
    active_target: z.string(),
    pool: z.record(poolEntry)
  }),
  voice_servers: z.object({
    active_target: z.string(),
    alert_threshold_percentage: z.number().int().min(1).max(100),
    pool: z.record(voicePoolEntry)
  })
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type FailoverConfig = z.infer<typeof failoverSchema>;

function readJsonFile<T>(absolutePath: string, schema: z.ZodSchema<T>): T {
  const raw = fs.readFileSync(absolutePath, "utf-8");
  const parsed = JSON.parse(raw);
  return schema.parse(parsed);
}

export function loadSharedConfig(repoRoot: string): { appConfig: AppConfig; failoverConfig: FailoverConfig } {
  const appConfigPath = path.join(repoRoot, "config", "app.config.json");
  const failoverPath = path.join(repoRoot, "config", "failover_config.json");

  const appConfig = readJsonFile(appConfigPath, appConfigSchema);
  const failoverConfig = readJsonFile(failoverPath, failoverSchema);

  return { appConfig, failoverConfig };
}
