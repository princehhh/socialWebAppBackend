function shapeMeta(meta: unknown): unknown {
  if (meta instanceof Error) {
    return {
      name: meta.name,
      message: meta.message,
      stack: meta.stack
    };
  }

  return meta ?? "";
}

export const logger = {
  info(message: string, meta?: unknown): void {
    console.log(`[INFO] ${new Date().toISOString()} ${message}`, shapeMeta(meta));
  },
  warn(message: string, meta?: unknown): void {
    console.warn(`[WARN] ${new Date().toISOString()} ${message}`, shapeMeta(meta));
  },
  error(message: string, meta?: unknown): void {
    console.error(`[ERROR] ${new Date().toISOString()} ${message}`, shapeMeta(meta));
  }
};
