import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";
import swaggerUi from "swagger-ui-express";
import { z } from "zod";
import { PrismaDatabaseProvider } from "./providers/db/PrismaDatabaseProvider";
import { runtimeConfig } from "./config/runtime";
import { authMiddleware } from "./middleware/auth";
import { fail, ok } from "./utils/apiResponse";
import { VoiceManager } from "./providers/voice/VoiceManager";
import { logger } from "./utils/logger";
import { trackEvent } from "./utils/analytics";
import { openApiDocument } from "./docs/openapi";

const dbProvider = new PrismaDatabaseProvider();
const prisma = dbProvider.getClient();
const app = express();

app.use(cors());
app.use(express.json());
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

app.get("/api-docs.json", (_req, res) => {
  return res.status(200).json(openApiDocument);
});

const actionCounters = new Map<string, { count: number; windowStart: number }>();
const ACTIVE_USER_WINDOW_MS = 90_000;

function isAllowedAction(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const current = actionCounters.get(key);
  if (!current || now - current.windowStart > windowMs) {
    actionCounters.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (current.count >= max) {
    return false;
  }
  current.count += 1;
  actionCounters.set(key, current);
  return true;
}

async function generateAnonymousId(): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const candidate = `SV${Math.floor(100000 + Math.random() * 899999)}`;
    const exists = await prisma.user.findUnique({ where: { anonymousId: candidate } });
    if (!exists) {
      return candidate;
    }
  }
  throw new Error("Unable to generate unique anonymous ID");
}

function normalizeMobileNumber(raw: string): string {
  const digitsOnly = raw.replace(/[^0-9]/g, "");
  if (digitsOnly.length === 10) {
    return `+91${digitsOnly}`;
  }
  return raw.startsWith("+") ? `+${digitsOnly}` : `+${digitsOnly}`;
}

function buildSessionToken(userId: string, sessionId: string): string {
  return jwt.sign({ userId, sessionId }, runtimeConfig.env.JWT_SECRET, { expiresIn: "30d" });
}

async function createSessionForUser(userId: string): Promise<string> {
  const session = await prisma.session.create({
    data: {
      userId,
      token: `session_${userId}_${Date.now()}`,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    }
  });
  return buildSessionToken(userId, session.id);
}

const mobileNumberSchema = z
  .string()
  .trim()
  .min(10)
  .max(18)
  .refine((value) => /^\+?[0-9\s\-()]+$/.test(value), "Invalid mobile number format")
  .transform((value) => normalizeMobileNumber(value));

app.get("/api/v1/health", async (_req, res) => {
  const dbHealthy = await dbProvider.healthCheck();
  return res.status(200).json(ok("Service healthy", {
    dbHealthy,
    activeDbProvider: runtimeConfig.getActiveDbTarget(),
    activeVoiceProvider: runtimeConfig.getActiveVoiceTarget()
  }));
});

app.get("/api/v1/config/public", (_req, res) => {
  const { app: appMeta, tabs, pages, languages, payments, featureFlags } = runtimeConfig.appConfig;
  return res.status(200).json(ok("Public configuration", { app: appMeta, tabs, pages, languages, payments, featureFlags }));
});

app.get("/api/v1/content/legal", (_req, res) => {
  const { terms, privacy, faqs } = runtimeConfig.appConfig.policies;
  return res.status(200).json(ok("Legal content", { terms, privacy, faqs }));
});

app.post("/api/v1/auth/mobile-login", async (req, res) => {
  const bodySchema = z.object({ mobileNumber: mobileNumberSchema });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid request payload", "INVALID_PAYLOAD"));
  }

  const existingUser = await prisma.user.findFirst({
    where: {
      mobileNumber: parsed.data.mobileNumber,
      isDeleted: false
    },
    include: { wallet: true }
  });

  if (!existingUser) {
    return res.status(200).json(ok("Mobile number not registered", {
      userExists: false,
      mobileNumber: parsed.data.mobileNumber
    }));
  }

  const user = await prisma.user.update({
    where: { id: existingUser.id },
    data: {
      currentStatus: "ONLINE",
      lastSeenAt: new Date()
    },
    include: { wallet: true }
  });

  const token = await createSessionForUser(user.id);
  await trackEvent(prisma, "mobile_login", user.id, { mobileNumber: user.mobileNumber });

  return res.status(200).json(ok("Login successful", {
    userExists: true,
    token,
    user: {
      id: user.id,
      anonymousId: user.anonymousId,
      mobileNumber: user.mobileNumber,
      name: user.name,
      preferredLanguage: user.preferredLanguage,
      currentStatus: user.currentStatus,
      coinBalance: user.wallet?.coinBalance ?? 0
    }
  }));
});

app.post("/api/v1/auth/mobile-signup", async (req, res) => {
  const bodySchema = z.object({
    mobileNumber: mobileNumberSchema,
    name: z.string().trim().min(2).max(60),
    referralCode: z.string().trim().min(3).max(30).optional(),
    preferredLanguage: z.string().optional()
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid request payload", "INVALID_PAYLOAD"));
  }

  const alreadyExists = await prisma.user.findFirst({
    where: {
      mobileNumber: parsed.data.mobileNumber,
      isDeleted: false
    }
  });

  if (alreadyExists) {
    return res.status(409).json(fail("User already registered with this mobile number", "USER_ALREADY_EXISTS"));
  }

  const preferredLanguage = parsed.data.preferredLanguage || runtimeConfig.appConfig.app.defaultLanguage;
  const anonymousId = await generateAnonymousId();

  const user = await prisma.user.create({
    data: {
      anonymousId,
      mobileNumber: parsed.data.mobileNumber,
      name: parsed.data.name,
      preferredLanguage,
      currentStatus: "ONLINE",
      wallet: { create: { coinBalance: runtimeConfig.appConfig.voice.minimumBalanceCoins } }
    },
    include: { wallet: true }
  });

  const token = await createSessionForUser(user.id);
  await trackEvent(prisma, "mobile_signup", user.id, {
    preferredLanguage,
    mobileNumber: user.mobileNumber,
    referralCode: parsed.data.referralCode || null
  });

  return res.status(201).json(ok("Signup successful", {
    token,
    user: {
      id: user.id,
      anonymousId: user.anonymousId,
      mobileNumber: user.mobileNumber,
      name: user.name,
      preferredLanguage: user.preferredLanguage,
      currentStatus: user.currentStatus,
      coinBalance: user.wallet?.coinBalance ?? 0
    }
  }));
});

app.post("/api/v1/auth/anonymous-login", async (req, res) => {
  const bodySchema = z.object({ preferredLanguage: z.string().optional() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid request payload", "INVALID_PAYLOAD"));
  }

  const preferredLanguage = parsed.data.preferredLanguage || runtimeConfig.appConfig.app.defaultLanguage;
  const anonymousId = await generateAnonymousId();

  const user = await prisma.user.create({
    data: {
      anonymousId,
      preferredLanguage,
      currentStatus: "ONLINE",
      wallet: { create: { coinBalance: runtimeConfig.appConfig.voice.minimumBalanceCoins } }
    },
    include: { wallet: true }
  });

  const token = await createSessionForUser(user.id);

  await trackEvent(prisma, "anonymous_login", user.id, { preferredLanguage });

  return res.status(201).json(ok("Anonymous login successful", {
    token,
    user: {
      id: user.id,
      anonymousId: user.anonymousId,
      mobileNumber: user.mobileNumber,
      name: user.name,
      preferredLanguage: user.preferredLanguage,
      currentStatus: user.currentStatus,
      coinBalance: user.wallet?.coinBalance ?? 0
    }
  }));
});

const requireAuth = authMiddleware(prisma);

app.get("/api/v1/users/available", requireAuth, async (req, res) => {
  const userId = req.authenticatedUserId as string;

  const blockedByMe = await prisma.block.findMany({ where: { blockerId: userId }, select: { blockedUserId: true } });
  const blockedSet = new Set(blockedByMe.map((b) => b.blockedUserId));

  const users = await prisma.user.findMany({
    where: {
      id: { not: userId },
      isDeleted: false,
      NOT: { id: { in: Array.from(blockedSet) } }
    },
    select: {
      id: true,
      anonymousId: true,
      name: true,
      currentStatus: true,
      preferredLanguage: true,
      lastSeenAt: true
    },
    orderBy: { createdAt: "desc" }
  });

  const nowMs = Date.now();
  const shapedUsers = users.map((user) => {
    const isRecentlyActive = nowMs - user.lastSeenAt.getTime() <= ACTIVE_USER_WINDOW_MS;
    const effectiveStatus = isRecentlyActive ? user.currentStatus : "OFFLINE";

    return {
      ...user,
      currentStatus: effectiveStatus
    };
  });

  return res.status(200).json(ok("Available users", shapedUsers));
});

app.patch("/api/v1/users/status", requireAuth, async (req, res) => {
  const bodySchema = z.object({ status: z.enum(["ONLINE", "OFFLINE", "BUSY"]) });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid status payload", "INVALID_PAYLOAD"));
  }

  const user = await prisma.user.update({
    where: { id: req.authenticatedUserId as string },
    data: {
      currentStatus: parsed.data.status,
      lastSeenAt: new Date()
    }
  });

  await trackEvent(prisma, "status_updated", user.id, { status: user.currentStatus });

  return res.status(200).json(ok("Status updated", {
    anonymousId: user.anonymousId,
    currentStatus: user.currentStatus,
    lastSeenAt: user.lastSeenAt
  }));
});

app.get("/api/v1/wallet", requireAuth, async (req, res) => {
  const wallet = await prisma.wallet.findUnique({
    where: { userId: req.authenticatedUserId as string },
    include: { transactions: { orderBy: { createdAt: "desc" }, take: 10 } }
  });

  if (!wallet) {
    return res.status(404).json(fail("Wallet not found", "WALLET_NOT_FOUND"));
  }

  return res.status(200).json(ok("Wallet fetched", {
    coinBalance: wallet.coinBalance,
    recentTransactions: wallet.transactions
  }));
});

app.get("/api/v1/wallet/transactions", requireAuth, async (req, res) => {
  const wallet = await prisma.wallet.findUnique({ where: { userId: req.authenticatedUserId as string } });
  if (!wallet) {
    return res.status(404).json(fail("Wallet not found", "WALLET_NOT_FOUND"));
  }

  const transactions = await prisma.transaction.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: "desc" }
  });

  return res.status(200).json(ok("Transaction history", transactions));
});

app.post("/api/v1/wallet/mock-topup", requireAuth, async (req, res) => {
  const bodySchema = z.object({ amountCoins: z.number().int().positive() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid top-up payload", "INVALID_PAYLOAD"));
  }

  const allowedPackages = runtimeConfig.appConfig.payments.topupPackages;
  if (!allowedPackages.includes(parsed.data.amountCoins)) {
    return res.status(400).json(fail("Amount is not in configured top-up packages", "INVALID_TOPUP_PACKAGE"));
  }

  const wallet = await prisma.wallet.findUnique({ where: { userId: req.authenticatedUserId as string } });
  if (!wallet) {
    return res.status(404).json(fail("Wallet not found", "WALLET_NOT_FOUND"));
  }

  const paymentStatus = runtimeConfig.env.MOCK_PAYMENT_AUTO_SUCCESS === "true" ? "SUCCESS" : "FAILED";
  if (paymentStatus !== "SUCCESS") {
    await prisma.transaction.create({
      data: {
        walletId: wallet.id,
        allocationType: "CREDIT",
        amountCoins: parsed.data.amountCoins,
        gatewayReference: `MOCK_${Date.now()}`,
        status: "FAILED",
        reason: "Mock payment disabled"
      }
    });
    return res.status(402).json(fail("Mock payment failed", "PAYMENT_FAILED"));
  }

  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { coinBalance: { increment: parsed.data.amountCoins } }
  });

  await prisma.transaction.create({
    data: {
      walletId: wallet.id,
      allocationType: "CREDIT",
      amountCoins: parsed.data.amountCoins,
      gatewayReference: `MOCK_${Date.now()}`,
      status: "SUCCESS",
      reason: "Mock top-up"
    }
  });

  await trackEvent(prisma, "wallet_topup", req.authenticatedUserId, { amount: parsed.data.amountCoins });

  const updatedWallet = await prisma.wallet.findUnique({ where: { id: wallet.id } });
  return res.status(200).json(ok("Coins added successfully", { coinBalance: updatedWallet?.coinBalance ?? 0 }));
});

app.post("/api/v1/calls/request", requireAuth, async (req, res) => {
  const bodySchema = z
    .object({
      receiverUserId: z.string().optional(),
      receiverAnonymousId: z.string().optional()
    })
    .refine((value) => Boolean(value.receiverUserId || value.receiverAnonymousId), {
      message: "Receiver identifier required"
    });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid call request payload", "INVALID_PAYLOAD"));
  }

  const callerId = req.authenticatedUserId as string;
  if (!isAllowedAction(`call:${callerId}`, 10, 60_000)) {
    return res.status(429).json(fail("Too many call attempts. Try again later.", "RATE_LIMITED"));
  }

  const caller = await prisma.user.findUnique({ where: { id: callerId }, include: { wallet: true } });
  const receiver = parsed.data.receiverUserId
    ? await prisma.user.findUnique({ where: { id: parsed.data.receiverUserId } })
    : await prisma.user.findUnique({ where: { anonymousId: parsed.data.receiverAnonymousId } });

  if (!caller || caller.isDeleted || !caller.wallet) {
    return res.status(404).json(fail("Caller not found", "CALLER_NOT_FOUND"));
  }
  if (!receiver || receiver.isDeleted) {
    return res.status(404).json(fail("Receiver not found", "RECEIVER_NOT_FOUND"));
  }
  if (receiver.id === callerId) {
    return res.status(400).json(fail("Cannot call yourself", "INVALID_RECEIVER"));
  }

  const blocked = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: callerId, blockedUserId: receiver.id },
        { blockerId: receiver.id, blockedUserId: callerId }
      ]
    }
  });

  if (blocked) {
    return res.status(403).json(fail("Call blocked by user privacy settings", "CALL_BLOCKED"));
  }

  if (caller.wallet.coinBalance < runtimeConfig.appConfig.voice.minimumBalanceCoins) {
    return res.status(402).json(fail("Insufficient balance for call start", "INSUFFICIENT_BALANCE"));
  }

  const call = await prisma.call.create({
    data: {
      callerId,
      receiverId: receiver.id,
      providerId: runtimeConfig.getActiveVoiceTarget(),
      status: "REQUESTED"
    }
  });

  const roomId = `room_${call.id}`;
  const voiceManager = new VoiceManager(runtimeConfig.getActiveVoiceTarget());
  const sessionData = await voiceManager.requestSession(roomId, callerId);

  await trackEvent(prisma, "call_requested", callerId, { callId: call.id, providerId: sessionData.providerId });

  return res.status(200).json(ok("Call session generated", {
    callId: call.id,
    sessionData,
    minimumBalanceCoins: runtimeConfig.appConfig.voice.minimumBalanceCoins
  }));
});

app.get("/api/v1/calls/incoming", requireAuth, async (req, res) => {
  const userId = req.authenticatedUserId as string;

  const incomingCall = await prisma.call.findFirst({
    where: {
      receiverId: userId,
      status: "REQUESTED"
    },
    include: {
      caller: {
        select: {
          id: true,
          anonymousId: true,
          name: true
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });

  if (!incomingCall) {
    return res.status(200).json(ok("No incoming call", null));
  }

  return res.status(200).json(ok("Incoming call", {
    callId: incomingCall.id,
    callerUserId: incomingCall.caller.id,
    callerAnonymousId: incomingCall.caller.anonymousId,
    callerName: incomingCall.caller.name,
    providerId: incomingCall.providerId,
    roomId: `room_${incomingCall.id}`,
    createdAt: incomingCall.createdAt
  }));
});

app.get("/api/v1/calls/status/:callId", requireAuth, async (req, res) => {
  const userId = req.authenticatedUserId as string;
  const callId = req.params.callId;

  const call = await prisma.call.findUnique({
    where: { id: callId },
    include: {
      caller: { select: { id: true, anonymousId: true, name: true } },
      receiver: { select: { id: true, anonymousId: true, name: true } }
    }
  });

  if (!call) {
    return res.status(404).json(fail("Call record not found", "CALL_NOT_FOUND"));
  }

  if (call.callerId !== userId && call.receiverId !== userId) {
    return res.status(403).json(fail("Not allowed to view this call", "NOT_CALL_PARTICIPANT"));
  }

  return res.status(200).json(ok("Call status", {
    callId: call.id,
    status: call.status,
    failureReason: call.failureReason,
    caller: call.caller,
    receiver: call.receiver,
    roomId: `room_${call.id}`,
    providerId: call.providerId,
    completedAt: call.completedAt
  }));
});

app.post("/api/v1/calls/respond", requireAuth, async (req, res) => {
  const bodySchema = z.object({
    callId: z.string(),
    action: z.enum(["ACCEPT", "REJECT"])
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid call response payload", "INVALID_PAYLOAD"));
  }

  const userId = req.authenticatedUserId as string;
  const call = await prisma.call.findUnique({
    where: { id: parsed.data.callId },
    include: {
      caller: { select: { anonymousId: true, name: true } },
      receiver: { select: { anonymousId: true, name: true } }
    }
  });

  if (!call) {
    return res.status(404).json(fail("Call record not found", "CALL_NOT_FOUND"));
  }

  if (call.receiverId !== userId) {
    return res.status(403).json(fail("Only receiver can respond", "NOT_RECEIVER"));
  }

  if (call.status !== "REQUESTED") {
    return res.status(409).json(fail("Call is no longer pending", "CALL_NOT_PENDING"));
  }

  if (parsed.data.action === "REJECT") {
    const rejected = await prisma.call.update({
      where: { id: call.id },
      data: {
        status: "FAILED",
        failureReason: "Rejected by receiver",
        completedAt: new Date()
      }
    });

    await trackEvent(prisma, "call_rejected", userId, { callId: call.id });
    return res.status(200).json(ok("Call rejected", {
      callId: rejected.id,
      status: rejected.status,
      failureReason: rejected.failureReason
    }));
  }

  const roomId = `room_${call.id}`;
  const voiceManager = new VoiceManager(runtimeConfig.getActiveVoiceTarget());
  const receiverSession = await voiceManager.requestSession(roomId, userId);

  await prisma.call.update({
    where: { id: call.id },
    data: {
      status: "IN_PROGRESS"
    }
  });

  await trackEvent(prisma, "call_accepted", userId, { callId: call.id });

  return res.status(200).json(ok("Call accepted", {
    callId: call.id,
    status: "IN_PROGRESS",
    sessionData: receiverSession,
    caller: call.caller,
    receiver: call.receiver
  }));
});

app.post("/api/v1/calls/complete", requireAuth, async (req, res) => {
  const bodySchema = z.object({
    callId: z.string(),
    durationSeconds: z.number().int().nonnegative(),
    status: z.enum(["COMPLETED", "FAILED"]),
    failureReason: z.string().optional()
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid call completion payload", "INVALID_PAYLOAD"));
  }

  const call = await prisma.call.findUnique({ where: { id: parsed.data.callId } });
  if (!call) {
    return res.status(404).json(fail("Call record not found", "CALL_NOT_FOUND"));
  }

  const requesterId = req.authenticatedUserId as string;
  if (call.callerId !== requesterId && call.receiverId !== requesterId) {
    return res.status(403).json(fail("Only call participants can complete this call", "NOT_CALL_PARTICIPANT"));
  }

  if (parsed.data.status === "FAILED") {
    const failed = await prisma.call.update({
      where: { id: call.id },
      data: {
        status: "FAILED",
        durationSeconds: parsed.data.durationSeconds,
        failureReason: parsed.data.failureReason || "Unknown failure",
        completedAt: new Date()
      }
    });

    await trackEvent(prisma, "call_failed", requesterId, { callId: call.id, reason: failed.failureReason });
    return res.status(200).json(ok("Call marked as failed", failed));
  }

  const wallet = await prisma.wallet.findUnique({ where: { userId: call.callerId } });
  if (!wallet) {
    return res.status(404).json(fail("Wallet not found", "WALLET_NOT_FOUND"));
  }

  const minutes = Math.max(1, Math.ceil(parsed.data.durationSeconds / 60));
  const coinsToCharge = minutes * runtimeConfig.appConfig.voice.coinChargePerMinute;
  if (wallet.coinBalance < coinsToCharge) {
    await prisma.call.update({
      where: { id: call.id },
      data: {
        status: "FAILED",
        durationSeconds: parsed.data.durationSeconds,
        failureReason: "Insufficient balance at call completion",
        completedAt: new Date()
      }
    });
    return res.status(402).json(fail("Insufficient balance for call completion", "INSUFFICIENT_BALANCE"));
  }

  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { coinBalance: { decrement: coinsToCharge } }
  });

  await prisma.transaction.create({
    data: {
      walletId: wallet.id,
      allocationType: "DEBIT",
      amountCoins: coinsToCharge,
      gatewayReference: `CALL_${call.id}`,
      status: "SUCCESS",
      reason: "Call charge"
    }
  });

  const completed = await prisma.call.update({
    where: { id: call.id },
    data: {
      status: "COMPLETED",
      durationSeconds: parsed.data.durationSeconds,
      coinsCharged: coinsToCharge,
      completedAt: new Date()
    }
  });

  await trackEvent(prisma, "call_completed", requesterId, { callId: call.id, coinsToCharge, durationSeconds: parsed.data.durationSeconds });

  return res.status(200).json(ok("Call completed", {
    call: completed,
    coinsCharged: coinsToCharge
  }));
});

app.get("/api/v1/calls/recent", requireAuth, async (req, res) => {
  const userId = req.authenticatedUserId as string;
  const calls = await prisma.call.findMany({
    where: {
      OR: [{ callerId: userId }, { receiverId: userId }]
    },
    include: {
      caller: { select: { anonymousId: true } },
      receiver: { select: { anonymousId: true } }
    },
    orderBy: { createdAt: "desc" },
    take: 50
  });

  const shaped = calls.map((call) => ({
    callId: call.id,
    callerAnonymousId: call.caller.anonymousId,
    receiverAnonymousId: call.receiver.anonymousId,
    durationSeconds: call.durationSeconds,
    createdAt: call.createdAt,
    status: call.status,
    coinsCharged: call.coinsCharged
  }));

  return res.status(200).json(ok("Recent calls", shaped));
});

app.post("/api/v1/reports", requireAuth, async (req, res) => {
  const bodySchema = z.object({ reportedAnonymousId: z.string(), reason: z.string().min(5) });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid report payload", "INVALID_PAYLOAD"));
  }

  const reporterId = req.authenticatedUserId as string;
  if (!isAllowedAction(`report:${reporterId}`, 20, 24 * 60 * 60 * 1000)) {
    return res.status(429).json(fail("Report rate limit exceeded", "RATE_LIMITED"));
  }

  const reportedUser = await prisma.user.findUnique({ where: { anonymousId: parsed.data.reportedAnonymousId } });
  if (!reportedUser) {
    return res.status(404).json(fail("Reported user not found", "USER_NOT_FOUND"));
  }

  const report = await prisma.report.create({
    data: {
      reporterId,
      reportedUserId: reportedUser.id,
      reason: parsed.data.reason
    }
  });

  await trackEvent(prisma, "user_reported", reporterId, { reportId: report.id });
  return res.status(201).json(ok("User reported", report));
});

app.post("/api/v1/blocks", requireAuth, async (req, res) => {
  const bodySchema = z.object({ blockedAnonymousId: z.string() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid block payload", "INVALID_PAYLOAD"));
  }

  const blockerId = req.authenticatedUserId as string;
  const blockedUser = await prisma.user.findUnique({ where: { anonymousId: parsed.data.blockedAnonymousId } });
  if (!blockedUser) {
    return res.status(404).json(fail("User not found", "USER_NOT_FOUND"));
  }

  const block = await prisma.block.upsert({
    where: {
      blockerId_blockedUserId: {
        blockerId,
        blockedUserId: blockedUser.id
      }
    },
    create: {
      blockerId,
      blockedUserId: blockedUser.id
    },
    update: {}
  });

  await trackEvent(prisma, "user_blocked", blockerId, { blockedUserId: blockedUser.id });
  return res.status(201).json(ok("User blocked", block));
});

app.patch("/api/v1/profile", requireAuth, async (req, res) => {
  const bodySchema = z.object({ preferredLanguage: z.string().optional() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid profile payload", "INVALID_PAYLOAD"));
  }

  const data: { preferredLanguage?: string } = {};
  if (parsed.data.preferredLanguage) {
    data.preferredLanguage = parsed.data.preferredLanguage;
  }

  const user = await prisma.user.update({
    where: { id: req.authenticatedUserId as string },
    data
  });

  await trackEvent(prisma, "profile_updated", user.id, parsed.data);
  return res.status(200).json(ok("Profile updated", user));
});

app.post("/api/v1/logout", requireAuth, async (req, res) => {
  const token = req.authToken as string;
  await prisma.user.update({
    where: { id: req.authenticatedUserId as string },
    data: {
      currentStatus: "OFFLINE",
      lastSeenAt: new Date()
    }
  });
  await prisma.session.deleteMany({ where: { userId: req.authenticatedUserId, token: { contains: "session_" } } });
  await trackEvent(prisma, "logout", req.authenticatedUserId, { tokenFragment: token.slice(0, 12) });
  return res.status(200).json(ok("Logged out"));
});

app.delete("/api/v1/account", requireAuth, async (req, res) => {
  const userId = req.authenticatedUserId as string;

  await prisma.user.update({
    where: { id: userId },
    data: {
      isDeleted: true,
      currentStatus: "OFFLINE"
    }
  });

  await prisma.session.deleteMany({ where: { userId } });
  await trackEvent(prisma, "account_deleted", userId);

  return res.status(200).json(ok("Account deleted"));
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error("Unhandled error", err);
  return res.status(500).json(fail("Internal server error", "INTERNAL_ERROR"));
});

async function start(): Promise<void> {
  await dbProvider.connect();

  app.listen(runtimeConfig.env.PORT, () => {
    logger.info(`Backend running on port ${runtimeConfig.env.PORT}`);
  });
}

start().catch((error) => {
  logger.error("Startup failed", error);
  process.exit(1);
});
