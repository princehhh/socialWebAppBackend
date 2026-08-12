import { PrismaClient } from "@prisma/client";

export async function trackEvent(
  prisma: PrismaClient,
  eventName: string,
  userId?: string,
  payload?: Record<string, unknown>
): Promise<void> {
  try {
    await prisma.analyticsEvent.create({
      data: {
        eventName,
        userId,
        payload: payload ? JSON.stringify(payload) : null
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[analytics] trackEvent failed: ${eventName}`, message);
  }
}
