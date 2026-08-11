import { loadSharedConfig } from "./sharedConfig";
import { env, runtimeRepoRoot } from "./env";

const { appConfig, failoverConfig } = loadSharedConfig(runtimeRepoRoot);

export const runtimeConfig = {
  env,
  appConfig,
  failoverConfig,
  getActiveVoiceTarget(): string {
    return env.VOICE_ACTIVE_TARGET || failoverConfig.voice_servers.active_target;
  },
  getActiveDbTarget(): string {
    return env.DB_ACTIVE_TARGET || failoverConfig.databases.active_target;
  }
};
