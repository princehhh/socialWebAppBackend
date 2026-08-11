export const logger = {
  info(message: string, meta?: unknown): void {
    console.log(`[INFO] ${new Date().toISOString()} ${message}`, meta ?? "");
  },
  warn(message: string, meta?: unknown): void {
    console.warn(`[WARN] ${new Date().toISOString()} ${message}`, meta ?? "");
  },
  error(message: string, meta?: unknown): void {
    console.error(`[ERROR] ${new Date().toISOString()} ${message}`, meta ?? "");
  }
};
