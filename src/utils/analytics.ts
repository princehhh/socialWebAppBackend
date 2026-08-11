import { PrismaClient } from "@prisma/client";

export async function trackEvent(
  prisma: PrismaClient,
  eventName: string,
  userId?: string,
  payload?: Record<string, unknown>
): Promise<void> {
  await prisma.analyticsEvent.create({
    data: {
      eventName,
      userId,
      payload: payload ? JSON.stringify(payload) : null
    }
  });
}
