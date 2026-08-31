import "express-async-errors";
import cors from "cors";
import express from "express";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import swaggerUi from "swagger-ui-express";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import { PrismaDatabaseProvider } from "./providers/db/PrismaDatabaseProvider";
import { runtimeConfig } from "./config/runtime";
import { AppConfig, appConfigSchema } from "./config/sharedConfig";
import { authMiddleware } from "./middleware/auth";
import { fail, ok } from "./utils/apiResponse";
import { VoiceManager } from "./providers/voice/VoiceManager";
import { logger } from "./utils/logger";
import { trackEvent } from "./utils/analytics";
import { openApiDocument } from "./docs/openapi";

const dbProvider = new PrismaDatabaseProvider();
const prisma = dbProvider.getClient();
const app = express();
const httpServer = createServer(app);
const presenceServer = new WebSocketServer({ noServer: true });
const exposeInternalErrors = runtimeConfig.env.EXPOSE_INTERNAL_ERRORS === "true";
const enableDbDiagnostics = runtimeConfig.env.ENABLE_DB_DIAGNOSTICS === "true";
const dbDiagnosticKey = runtimeConfig.env.DB_DIAGNOSTIC_KEY || "";
const allowedOrigins = new Set([
  ...runtimeConfig.env.CORS_ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
  runtimeConfig.env.RENDER_EXTERNAL_URL
].filter((origin): origin is string => Boolean(origin)));

function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins.has(origin);
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
  process.exit(1);
});

app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=()");
  next();
});
const apiCors = cors({
  origin(origin, callback) {
    if (!origin || isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin is not allowed"));
  },
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Authorization", "Content-Type", "x-diagnostic-key"]
});
app.use((req, res, next) => {
  if (req.path.startsWith("/admin")) {
    next();
    return;
  }
  apiCors(req, res, next);
});
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    logger.info("HTTP request", {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
  next();
});
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

app.get("/api-docs.json", (_req, res) => {
  return res.status(200).json(openApiDocument);
});

const actionCounters = new Map<string, { count: number; windowStart: number }>();
const ACTIVE_USER_WINDOW_MS = 60_000;
type PresenceSocket = WebSocket & { userId?: string; isAlive?: boolean };
const presenceSockets = new Map<string, Set<PresenceSocket>>();

function hasActivePresenceSocket(userId: string): boolean {
  return (presenceSockets.get(userId)?.size || 0) > 0;
}

function publishPresenceUpdate(user: { id: string; anonymousId: string; name: string | null; currentStatus: string; preferredLanguage: string }): void {
  const message = JSON.stringify({
    type: "presence",
    user: {
      id: user.id,
      anonymousId: user.anonymousId,
      name: user.name,
      currentStatus: user.currentStatus,
      preferredLanguage: user.preferredLanguage
    }
  });
  for (const [userId, sockets] of presenceSockets) {
    if (userId === user.id) {
      continue;
    }
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    }
  }
}

function publishToUser(userId: string, message: Record<string, unknown>): void {
  const serializedMessage = JSON.stringify(message);
  for (const socket of presenceSockets.get(userId) || []) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(serializedMessage);
    }
  }
}

async function updatePresence(userIds: string[], status: "ONLINE" | "OFFLINE" | "BUSY"): Promise<void> {
  await prisma.user.updateMany({
    where: { id: { in: userIds } },
    data: { currentStatus: status, lastSeenAt: new Date() }
  });
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, anonymousId: true, name: true, currentStatus: true, preferredLanguage: true }
  });
  users.forEach(publishPresenceUpdate);
}

async function sendPresenceSnapshot(userId: string, socket: PresenceSocket): Promise<void> {
  const blockedByMe = await prisma.block.findMany({ where: { blockerId: userId }, select: { blockedUserId: true } });
  const blockedSet = new Set(blockedByMe.map((block) => block.blockedUserId));
  const users = await prisma.user.findMany({
    where: {
      id: { not: userId },
      isDeleted: false,
      NOT: { id: { in: Array.from(blockedSet) } }
    },
    select: { id: true, anonymousId: true, name: true, currentStatus: true, preferredLanguage: true, lastSeenAt: true }
  });
  const nowMs = Date.now();
  const visibleUsers = users
    .map((user) => ({
      id: user.id,
      anonymousId: user.anonymousId,
      name: user.name,
      currentStatus: nowMs - user.lastSeenAt.getTime() <= ACTIVE_USER_WINDOW_MS || hasActivePresenceSocket(user.id) ? user.currentStatus : "OFFLINE",
      preferredLanguage: user.preferredLanguage
    }))
    .filter((user) => user.currentStatus === "ONLINE");

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "presence-snapshot", users: visibleUsers }));
  }
}

presenceServer.on("connection", (socket: PresenceSocket) => {
  const authenticationTimeout = setTimeout(() => socket.close(1008, "Authentication required"), 5_000);

  socket.on("message", async (rawMessage) => {
    if (socket.userId) {
      return;
    }
    try {
      const message = JSON.parse(rawMessage.toString()) as { type?: string; token?: string };
      if (message.type !== "authenticate" || !message.token) {
        socket.close(1008, "Invalid authentication message");
        return;
      }
      const decoded = jwt.verify(message.token, runtimeConfig.env.JWT_SECRET) as { userId: string; sessionId: string };
      const session = await prisma.session.findUnique({ where: { id: decoded.sessionId } });
      if (!session || session.userId !== decoded.userId || session.expiresAt < new Date()) {
        socket.close(1008, "Session expired");
        return;
      }
      clearTimeout(authenticationTimeout);
      socket.userId = decoded.userId;
      socket.isAlive = true;
      const sockets = presenceSockets.get(decoded.userId) || new Set<PresenceSocket>();
      sockets.add(socket);
      presenceSockets.set(decoded.userId, sockets);
      await updatePresence([decoded.userId], "ONLINE");
      await sendPresenceSnapshot(decoded.userId, socket);
    } catch {
      socket.close(1008, "Authentication failed");
    }
  });

  socket.on("pong", () => {
    socket.isAlive = true;
  });
  socket.on("close", () => {
    clearTimeout(authenticationTimeout);
    if (!socket.userId) {
      return;
    }
    const sockets = presenceSockets.get(socket.userId);
    sockets?.delete(socket);
    if (!sockets?.size) {
      presenceSockets.delete(socket.userId);
      updatePresence([socket.userId], "OFFLINE").catch((error) => logger.error("Presence disconnect update failed", error));
    }
  });
});

const presencePingInterval = setInterval(() => {
  for (const sockets of presenceSockets.values()) {
    for (const socket of sockets) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }
}, 30_000);

httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const origin = request.headers.origin;
  if (url.pathname !== "/api/v1/presence" || (origin && !isAllowedOrigin(origin))) {
    socket.destroy();
    return;
  }
  presenceServer.handleUpgrade(request, socket, head, (webSocket) => {
    presenceServer.emit("connection", webSocket, request);
  });
});

httpServer.on("close", () => clearInterval(presencePingInterval));

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

let activeAppConfig: AppConfig = runtimeConfig.appConfig;
const ADMIN_SETTINGS_KEY = "app-config";
const ADMIN_COOKIE_NAME = "socialvoice_admin";
const adminId = runtimeConfig.env.ADMIN_ID || "abc";
const adminPassword = runtimeConfig.env.ADMIN_PASSWORD || "dummy";
const adminSessions = new Map<string, number>();
const ADMIN_SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

function isFeatureEnabled(flagName: string): boolean {
  return activeAppConfig.featureFlags[flagName] === true;
}

function requireFeature(flagName: string) {
  return (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!isFeatureEnabled(flagName)) {
      return res.status(403).json(fail(`Feature '${flagName}' is disabled`, "FEATURE_DISABLED"));
    }
    return next();
  };
}

function getAdminToken(req: express.Request): string | undefined {
  const cookie = req.headers.cookie?.split(";").find((entry) => entry.trim().startsWith(`${ADMIN_COOKIE_NAME}=`));
  return cookie?.split("=").slice(1).join("=");
}

function isAdminRequest(req: express.Request): boolean {
  const token = getAdminToken(req);
  if (!token) {
    return false;
  }
  const expiresAt = adminSessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!isAdminRequest(req)) {
    res.status(401).json(fail("Admin authentication required", "ADMIN_AUTH_REQUIRED"));
    return;
  }
  next();
}

function renderAdminLogin(errorMessage = ""): string {
  const error = errorMessage ? `<p class="error">${errorMessage}</p>` : "";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>SocialVoice Admin</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#f1f5fb;color:#182a4b;display:grid;min-height:100vh;place-items:center}.panel{width:min(360px,calc(100% - 40px));background:#fff;padding:28px;border-radius:8px;box-shadow:0 12px 35px #1d315426}h1{margin:0 0 8px}p{color:#536786}label{display:block;margin-top:16px;font-weight:600}input,button,textarea{box-sizing:border-box;width:100%;font:inherit}input,textarea{margin-top:6px;padding:10px;border:1px solid #b9c7dd;border-radius:6px}button{margin-top:22px;padding:11px;border:0;border-radius:6px;background:#2864dc;color:#fff;font-weight:700;cursor:pointer}.error{color:#b42318}</style></head><body><main class="panel"><h1>Admin</h1><p>Manage SocialVoice configuration.</p>${error}<form id="admin-login-form" method="post" action="/admin/login"><label>Admin ID<input name="adminId" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form></main><script>document.getElementById("admin-login-form").addEventListener("submit",async function(event){event.preventDefault();const form=event.currentTarget;const response=await fetch("/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({adminId:form.elements.adminId.value,password:form.elements.password.value})});if(response.redirected){location.assign(response.url);return}document.open();document.write(await response.text());document.close()})</script></body></html>`;
}

function renderAdminPanel(): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>SocialVoice Admin</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#f1f5fb;color:#182a4b}.page{max-width:900px;margin:0 auto;padding:32px 20px}header{display:flex;align-items:center;justify-content:space-between;gap:16px}h1{margin:0}.note{color:#536786;line-height:1.5}textarea{box-sizing:border-box;width:100%;min-height:560px;padding:14px;border:1px solid #b9c7dd;border-radius:6px;font:13px ui-monospace,monospace;line-height:1.45}button{padding:10px 16px;border:0;border-radius:6px;background:#2864dc;color:#fff;font-weight:700;cursor:pointer}.secondary{background:#5d6f8c}.status{min-height:24px;margin:14px 0;color:#176a3a}.error{color:#b42318}</style></head><body><main class="page"><header><div><h1>SocialVoice Admin</h1><p class="note">Edit validated application settings. Changes apply immediately and persist after restart.</p></div><button class="secondary" onclick="location.href='/admin/logout'">Sign out</button></header><textarea id="settings" aria-label="Application settings"></textarea><p id="status" class="status"></p><button id="save">Save settings</button></main><script>const editor=document.getElementById('settings'),status=document.getElementById('status');async function load(){const response=await fetch('/admin/api/settings');if(!response.ok)throw new Error('Unable to load settings');editor.value=JSON.stringify(await response.json(),null,2)}document.getElementById('save').onclick=async()=>{try{const response=await fetch('/admin/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:editor.value});if(!response.ok)throw new Error((await response.json()).message||'Settings were rejected');editor.value=JSON.stringify(await response.json(),null,2);status.className='status';status.textContent='Settings saved.'}catch(error){status.className='status error';status.textContent=error instanceof Error?error.message:'Unable to save settings'}};load().catch(error=>{status.className='status error';status.textContent=error.message})</script></body></html>`;
}

async function loadActiveAppConfig(): Promise<void> {
  try {
    const setting = await prisma.appSetting.findUnique({ where: { key: ADMIN_SETTINGS_KEY } });
    if (setting) {
      activeAppConfig = appConfigSchema.parse(setting.value);
    }
  } catch (error) {
    logger.error("Unable to load admin settings; using file configuration", error);
  }
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

function mapAuthError(error: unknown): { message: string; errorCode: string; status: number } {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2022") {
      return {
        message: "Database schema is out of sync (missing column). Run prisma db push on deployed environment.",
        errorCode: "DB_SCHEMA_OUT_OF_SYNC",
        status: 500
      };
    }

    if (error.code === "P2021") {
      return {
        message: "Database schema is out of sync (missing table). Run prisma db push on deployed environment.",
        errorCode: "DB_SCHEMA_OUT_OF_SYNC",
        status: 500
      };
    }

    if (error.code === "P1001") {
      return {
        message: "Database is not reachable from backend service.",
        errorCode: "DB_UNREACHABLE",
        status: 503
      };
    }

    if (error.code === "P1008") {
      return {
        message: "Database operation timed out.",
        errorCode: "DB_TIMEOUT",
        status: 504
      };
    }
  }

  return {
    message: "Mobile login failed",
    errorCode: "MOBILE_LOGIN_FAILED",
    status: 500
  };
}

function authorizeDbDiagnostics(req: express.Request, res: express.Response): boolean {
  if (!enableDbDiagnostics) {
    res.status(404).json(fail("Not found", "NOT_FOUND"));
    return false;
  }

  if (!dbDiagnosticKey) {
    res.status(404).json(fail("Not found", "NOT_FOUND"));
    return false;
  }

  const providedKey = req.header("x-diagnostic-key") || "";
  if (providedKey !== dbDiagnosticKey) {
    res.status(401).json(fail("Invalid diagnostic key", "UNAUTHORIZED"));
    return false;
  }

  return true;
}

function shapeDbDiagnosticError(error: unknown): { errorCode: string; message: string } {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return {
      errorCode: `PRISMA_${error.code}`,
      message: error.message
    };
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return {
      errorCode: "PRISMA_INIT_ERROR",
      message: error.message
    };
  }

  if (error instanceof Error) {
    return {
      errorCode: "DB_DIAGNOSTIC_ERROR",
      message: error.message
    };
  }

  return {
    errorCode: "DB_DIAGNOSTIC_ERROR",
    message: String(error)
  };
}

function getSafeErrorDetail(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `PrismaKnownError code=${error.code} message=${error.message.slice(0, 220)}`;
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return `PrismaInitializationError message=${error.message.slice(0, 220)}`;
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message.slice(0, 220)}`;
  }

  return String(error).slice(0, 220);
}

app.get("/api/v1/health", async (_req, res) => {
  return res.status(200).json(ok("Service available", { status: "ok" }));
});

app.get("/api/v1", (_req, res) => {
  return res.status(200).json(ok("Service available", { status: "ok" }));
});

app.use("/admin", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  next();
});

app.get("/admin", (req, res) => {
  return res.status(200).type("html").send(isAdminRequest(req) ? renderAdminPanel() : renderAdminLogin());
});

app.get("/admin/login", (_req, res) => {
  return res.redirect("/admin");
});

app.post("/admin/login", (req, res) => {
  const credentials = z.object({
    adminId: z.string().min(1),
    password: z.string().min(1)
  }).safeParse(req.body);
  if (!credentials.success || !isAllowedAction(`admin-login:${req.ip}`, 5, 15 * 60_000) || credentials.data.adminId !== adminId || credentials.data.password !== adminPassword) {
    return res.status(401).type("html").send(renderAdminLogin("Invalid credentials."));
  }
  try {
    const token = randomBytes(32).toString("hex");
    adminSessions.set(token, Date.now() + ADMIN_SESSION_DURATION_MS);
    res.cookie(ADMIN_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: runtimeConfig.env.NODE_ENV === "production",
      maxAge: ADMIN_SESSION_DURATION_MS
    });
    return res.redirect("/admin");
  } catch (error) {
    logger.error("Admin login failed", error);
    return res.status(500).type("html").send(renderAdminLogin("Unable to start an admin session. Check the server logs."));
  }
});

app.get("/admin/logout", (_req, res) => {
  res.clearCookie(ADMIN_COOKIE_NAME);
  return res.redirect("/admin");
});

app.get("/admin/api/settings", requireAdmin, (_req, res) => {
  return res.status(200).json(activeAppConfig);
});

app.patch("/admin/api/settings", requireAdmin, async (req, res) => {
  const parsed = appConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Settings do not match the required configuration format", "INVALID_SETTINGS"));
  }
  activeAppConfig = parsed.data;
  await prisma.appSetting.upsert({
    where: { key: ADMIN_SETTINGS_KEY },
    create: { key: ADMIN_SETTINGS_KEY, value: parsed.data as Prisma.InputJsonValue },
    update: { value: parsed.data as Prisma.InputJsonValue }
  });
  logger.info("Admin settings updated", { adminId, featureFlags: activeAppConfig.featureFlags });
  return res.status(200).json(activeAppConfig);
});

app.get("/api/v1/config/public", (_req, res) => {
  const { app: appMeta, tabs, pages, languages, payments, featureFlags, voice, chat } = activeAppConfig;
  return res.status(200).json(ok("Public configuration", {
    app: appMeta,
    tabs,
    pages,
    languages,
    payments,
    featureFlags,
    voice,
    chat
  }));
});

app.get("/api/v1/content/legal", (_req, res) => {
  const { terms, privacy, faqs } = runtimeConfig.appConfig.policies;
  return res.status(200).json(ok("Legal content", { terms, privacy, faqs }));
});

app.get("/api/v1/diagnostics/db/health", async (req, res) => {
  if (!authorizeDbDiagnostics(req, res)) {
    return;
  }

  try {
    const dbHealthy = await dbProvider.healthCheck();
    const pingResult = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT NOW() as now`;

    return res.status(200).json(ok("DB health diagnostic", {
      dbHealthy,
      pingOk: true,
      serverTime: pingResult[0]?.now ?? null
    }));
  } catch (error) {
    const shaped = shapeDbDiagnosticError(error);
    logger.error("DB diagnostics health failed", error);
    return res.status(500).json(fail(`DB health diagnostic failed: ${shaped.message}`, shaped.errorCode));
  }
});

app.get("/api/v1/diagnostics/db/read", async (req, res) => {
  if (!authorizeDbDiagnostics(req, res)) {
    return;
  }

  try {
    const [userCount, walletCount, callCount, analyticsCount] = await Promise.all([
      prisma.user.count(),
      prisma.wallet.count(),
      prisma.call.count(),
      prisma.analyticsEvent.count()
    ]);

    return res.status(200).json(ok("DB read diagnostic", {
      readOk: true,
      counts: {
        users: userCount,
        wallets: walletCount,
        calls: callCount,
        analyticsEvents: analyticsCount
      }
    }));
  } catch (error) {
    const shaped = shapeDbDiagnosticError(error);
    logger.error("DB diagnostics read failed", error);
    return res.status(500).json(fail(`DB read diagnostic failed: ${shaped.message}`, shaped.errorCode));
  }
});

app.post("/api/v1/diagnostics/db/write", async (req, res) => {
  if (!authorizeDbDiagnostics(req, res)) {
    return;
  }

  try {
    const marker = `diag_${Date.now()}`;
    const writeResult = await prisma.$transaction(async (tx) => {
      const created = await tx.analyticsEvent.create({
        data: {
          eventName: "db_diagnostic",
          payload: JSON.stringify({ marker, step: "create" })
        }
      });

      const updated = await tx.analyticsEvent.update({
        where: { id: created.id },
        data: {
          payload: JSON.stringify({ marker, step: "update" })
        }
      });

      await tx.analyticsEvent.delete({ where: { id: created.id } });

      return {
        createdId: created.id,
        updatedPayload: updated.payload
      };
    });

    return res.status(200).json(ok("DB write diagnostic", {
      writeOk: true,
      createOk: Boolean(writeResult.createdId),
      updateOk: Boolean(writeResult.updatedPayload),
      deleteOk: true
    }));
  } catch (error) {
    const shaped = shapeDbDiagnosticError(error);
    logger.error("DB diagnostics write failed", error);
    return res.status(500).json(fail(`DB write diagnostic failed: ${shaped.message}`, shaped.errorCode));
  }
});

app.post("/api/v1/auth/mobile-login", async (req, res) => {
  try {
    if (!isAllowedAction(`login:${req.ip}`, 10, 15 * 60_000)) {
      return res.status(429).json(fail("Too many login attempts. Try again later.", "RATE_LIMITED"));
    }
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
  } catch (error) {
    logger.error("Mobile login failed", error);
    const shapedError = mapAuthError(error);
    const message = exposeInternalErrors
      ? `${shapedError.message} | detail: ${getSafeErrorDetail(error)}`
      : shapedError.message;
    return res.status(shapedError.status).json(fail(message, shapedError.errorCode));
  }
});

app.post("/api/v1/auth/mobile-signup", async (req, res) => {
  try {
    if (!isAllowedAction(`signup:${req.ip}`, 5, 60 * 60_000)) {
      return res.status(429).json(fail("Too many signup attempts. Try again later.", "RATE_LIMITED"));
    }
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

    const preferredLanguage = parsed.data.preferredLanguage || activeAppConfig.app.defaultLanguage;
    const anonymousId = await generateAnonymousId();

    const user = await prisma.user.create({
      data: {
        anonymousId,
        mobileNumber: parsed.data.mobileNumber,
        name: parsed.data.name,
        preferredLanguage,
        currentStatus: "ONLINE",
        wallet: { create: { coinBalance: activeAppConfig.voice.minimumBalanceCoins } }
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
  } catch (error) {
    logger.error("Mobile signup failed", error);
    const shapedError = mapAuthError(error);
    const message = exposeInternalErrors
      ? `${shapedError.message} | detail: ${getSafeErrorDetail(error)}`
      : shapedError.message;
    return res.status(shapedError.status).json(fail(message, shapedError.errorCode));
  }
});

app.post("/api/v1/auth/anonymous-login", async (req, res) => {
  const bodySchema = z.object({ preferredLanguage: z.string().optional() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid request payload", "INVALID_PAYLOAD"));
  }

  const preferredLanguage = parsed.data.preferredLanguage || activeAppConfig.app.defaultLanguage;
  const anonymousId = await generateAnonymousId();

  const user = await prisma.user.create({
    data: {
      anonymousId,
      preferredLanguage,
      currentStatus: "ONLINE",
      wallet: { create: { coinBalance: activeAppConfig.voice.minimumBalanceCoins } }
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

app.get("/api/v1/auth/session", requireAuth, async (req, res) => {
  const existingUser = await prisma.user.findFirst({ where: { id: req.authenticatedUserId as string, isDeleted: false } });

  if (!existingUser) {
    return res.status(401).json(fail("Session user no longer exists", "SESSION_INVALID"));
  }

  const user = await prisma.user.update({
    where: { id: existingUser.id },
    data: { currentStatus: "ONLINE", lastSeenAt: new Date() },
    include: { wallet: true }
  });

  return res.status(200).json(ok("Session valid", {
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
    const effectiveStatus = isRecentlyActive || hasActivePresenceSocket(user.id) ? user.currentStatus : "OFFLINE";

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
  publishPresenceUpdate(user);

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

  const allowedPackages = activeAppConfig.payments.topupPackages;
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
      receiverAnonymousId: z.string().optional(),
      callType: z.enum(["VOICE", "VIDEO"]).default("VOICE")
    })
    .refine((value) => Boolean(value.receiverUserId || value.receiverAnonymousId), {
      message: "Receiver identifier required"
    });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid call request payload", "INVALID_PAYLOAD"));
  }

  if (parsed.data.callType === "VIDEO" && !isFeatureEnabled("enableVideoCall")) {
    return res.status(403).json(fail("Video calling is disabled", "FEATURE_DISABLED"));
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

  const receiverIsActive = Date.now() - receiver.lastSeenAt.getTime() <= ACTIVE_USER_WINDOW_MS || hasActivePresenceSocket(receiver.id);
  if (receiver.currentStatus !== "ONLINE" || !receiverIsActive) {
    return res.status(409).json(fail("This user is currently offline", "RECEIVER_OFFLINE"));
  }

  const ongoingCall = await prisma.call.findFirst({
    where: {
      status: { in: ["REQUESTED", "IN_PROGRESS"] },
      OR: [
        { callerId },
        { receiverId: callerId },
        { callerId: receiver.id },
        { receiverId: receiver.id }
      ]
    }
  });
  if (ongoingCall) {
    return res.status(409).json(fail("This user is busy on another call", "USER_BUSY"));
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

  if (caller.wallet.coinBalance < activeAppConfig.voice.minimumBalanceCoins) {
    return res.status(402).json(fail("Insufficient balance for call start", "INSUFFICIENT_BALANCE"));
  }

  const call = await prisma.call.create({
    data: {
      callerId,
      receiverId: receiver.id,
      providerId: runtimeConfig.getActiveVoiceTarget(),
      callType: parsed.data.callType,
      status: "REQUESTED"
    }
  });

  await updatePresence([callerId, receiver.id], "BUSY");

  publishToUser(receiver.id, {
    type: "incoming-call",
    call: {
      callId: call.id,
      callerAnonymousId: caller.anonymousId,
      callerName: caller.name,
      callType: call.callType,
      roomId: `room_${call.id}`
    }
  });

  const roomId = `room_${call.id}`;
  const voiceManager = new VoiceManager(runtimeConfig.getActiveVoiceTarget());
  const sessionData = await voiceManager.requestSession(roomId, callerId, parsed.data.callType);

  await trackEvent(prisma, "call_requested", callerId, {
    callId: call.id,
    providerId: sessionData.providerId,
    callType: call.callType
  });

  return res.status(200).json(ok("Call session generated", {
    callId: call.id,
    callType: call.callType,
    sessionData,
    minimumBalanceCoins: activeAppConfig.voice.minimumBalanceCoins
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
    callType: incomingCall.callType,
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
    callType: call.callType,
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

    await updatePresence([call.callerId, call.receiverId], "ONLINE");

    await trackEvent(prisma, "call_rejected", userId, { callId: call.id });
    return res.status(200).json(ok("Call rejected", {
      callId: rejected.id,
      status: rejected.status,
      failureReason: rejected.failureReason
    }));
  }

  const roomId = `room_${call.id}`;
  const voiceManager = new VoiceManager(runtimeConfig.getActiveVoiceTarget());
  const receiverSession = await voiceManager.requestSession(roomId, userId, call.callType === "VIDEO" ? "VIDEO" : "VOICE");

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
    callType: call.callType,
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

    await updatePresence([call.callerId, call.receiverId], "ONLINE");

    await trackEvent(prisma, "call_failed", requesterId, { callId: call.id, reason: failed.failureReason });
    return res.status(200).json(ok("Call marked as failed", failed));
  }

  const wallet = await prisma.wallet.findUnique({ where: { userId: call.callerId } });
  if (!wallet) {
    return res.status(404).json(fail("Wallet not found", "WALLET_NOT_FOUND"));
  }

  const minutes = Math.max(1, Math.ceil(parsed.data.durationSeconds / 60));
  const ratePerMinute =
    call.callType === "VIDEO"
      ? activeAppConfig.voice.videoCoinChargePerMinute
      : activeAppConfig.voice.coinChargePerMinute;
  const coinsToCharge = minutes * ratePerMinute;
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

  await updatePresence([call.callerId, call.receiverId], "ONLINE");

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
      caller: { select: { id: true, anonymousId: true, name: true, currentStatus: true, preferredLanguage: true, lastSeenAt: true } },
      receiver: { select: { id: true, anonymousId: true, name: true, currentStatus: true, preferredLanguage: true, lastSeenAt: true } }
    },
    orderBy: { createdAt: "desc" },
    take: 50
  });

  const shaped = calls.map((call) => {
    const otherUser = call.callerId === userId ? call.receiver : call.caller;
    const isRecentlyActive = Date.now() - otherUser.lastSeenAt.getTime() <= ACTIVE_USER_WINDOW_MS;

    return {
      callId: call.id,
      callerAnonymousId: call.caller.anonymousId,
      receiverAnonymousId: call.receiver.anonymousId,
      durationSeconds: call.durationSeconds,
      createdAt: call.createdAt,
      status: call.status,
      callType: call.callType,
      coinsCharged: call.coinsCharged,
      otherUser: {
        id: otherUser.id,
        anonymousId: otherUser.anonymousId,
        name: otherUser.name,
        preferredLanguage: otherUser.preferredLanguage,
        currentStatus: isRecentlyActive || hasActivePresenceSocket(otherUser.id) ? otherUser.currentStatus : "OFFLINE"
      }
    };
  });

  return res.status(200).json(ok("Recent calls", shaped));
});

const requireChatFeature = requireFeature("enableChat");

function shapeChatMessage(message: {
  id: string;
  senderId: string;
  receiverId: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
}, viewerId: string) {
  return {
    id: message.id,
    senderId: message.senderId,
    receiverId: message.receiverId,
    body: message.body,
    isMine: message.senderId === viewerId,
    readAt: message.readAt,
    createdAt: message.createdAt
  };
}

app.post("/api/v1/chat/messages", requireAuth, requireChatFeature, async (req, res) => {
  const bodySchema = z.object({
    receiverUserId: z.string().min(1),
    body: z.string().trim().min(1).max(activeAppConfig.chat.maxMessageLength)
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid chat message payload", "INVALID_PAYLOAD"));
  }

  const senderId = req.authenticatedUserId as string;
  if (parsed.data.receiverUserId === senderId) {
    return res.status(400).json(fail("Cannot message yourself", "INVALID_RECEIVER"));
  }

  if (!isAllowedAction(`chat:${senderId}`, 60, 60_000)) {
    return res.status(429).json(fail("Too many messages. Slow down.", "RATE_LIMITED"));
  }

  const receiver = await prisma.user.findFirst({
    where: { id: parsed.data.receiverUserId, isDeleted: false }
  });
  if (!receiver) {
    return res.status(404).json(fail("Receiver not found", "RECEIVER_NOT_FOUND"));
  }

  const blocked = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: senderId, blockedUserId: receiver.id },
        { blockerId: receiver.id, blockedUserId: senderId }
      ]
    }
  });
  if (blocked) {
    return res.status(403).json(fail("Chat blocked by user privacy settings", "CHAT_BLOCKED"));
  }

  const message = await prisma.chatMessage.create({
    data: {
      senderId,
      receiverId: receiver.id,
      body: parsed.data.body
    }
  });

  await trackEvent(prisma, "chat_message_sent", senderId, { receiverId: receiver.id });

  return res.status(201).json(ok("Message sent", shapeChatMessage(message, senderId)));
});

app.get("/api/v1/chat/messages/:peerUserId", requireAuth, requireChatFeature, async (req, res) => {
  const viewerId = req.authenticatedUserId as string;
  const peerUserId = req.params.peerUserId;

  const querySchema = z.object({
    afterCreatedAt: z.string().datetime().optional()
  });
  const parsedQuery = querySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json(fail("Invalid chat history query", "INVALID_PAYLOAD"));
  }

  const conversationFilter = {
    OR: [
      { senderId: viewerId, receiverId: peerUserId },
      { senderId: peerUserId, receiverId: viewerId }
    ]
  };

  const messages = await prisma.chatMessage.findMany({
    where: parsedQuery.data.afterCreatedAt
      ? { AND: [conversationFilter, { createdAt: { gt: new Date(parsedQuery.data.afterCreatedAt) } }] }
      : conversationFilter,
    orderBy: { createdAt: "desc" },
    take: activeAppConfig.chat.historyPageSize
  });

  await prisma.chatMessage.updateMany({
    where: { senderId: peerUserId, receiverId: viewerId, readAt: null },
    data: { readAt: new Date() }
  });

  const ordered = messages.slice().reverse().map((message) => shapeChatMessage(message, viewerId));
  return res.status(200).json(ok("Chat history", ordered));
});

app.get("/api/v1/chat/unread-count", requireAuth, requireChatFeature, async (req, res) => {
  const viewerId = req.authenticatedUserId as string;
  const unreadCount = await prisma.chatMessage.count({
    where: { receiverId: viewerId, readAt: null }
  });

  return res.status(200).json(ok("Unread chat count", { unreadCount }));
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
  const userId = req.authenticatedUserId as string;
  await updatePresence([userId], "OFFLINE");
  presenceSockets.get(userId)?.forEach((socket) => socket.close(1000, "Logged out"));
  await prisma.session.deleteMany({ where: { userId: req.authenticatedUserId, token: { contains: "session_" } } });
  await trackEvent(prisma, "logout", req.authenticatedUserId, { tokenFragment: token.slice(0, 12) });
  return res.status(200).json(ok("Logged out"));
});

app.delete("/api/v1/account", requireAuth, async (req, res) => {
  const userId = req.authenticatedUserId as string;

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      isDeleted: true,
      currentStatus: "OFFLINE"
    }
  });

  publishPresenceUpdate(user);
  presenceSockets.get(userId)?.forEach((socket) => socket.close(1000, "Account deleted"));

  await prisma.session.deleteMany({ where: { userId } });
  await trackEvent(prisma, "account_deleted", userId);

  return res.status(200).json(ok("Account deleted"));
});

app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error("Unhandled error", err);
  if (req.path.startsWith("/admin")) {
    return res.status(500).type("html").send(renderAdminLogin("Unable to complete the admin request. Check the Render service logs."));
  }
  return res.status(500).json(fail("Internal server error", "INTERNAL_ERROR"));
});

async function start(): Promise<void> {
  await dbProvider.connect();
  await loadActiveAppConfig();

  httpServer.listen(runtimeConfig.env.PORT, () => {
    logger.info(`Backend running on port ${runtimeConfig.env.PORT}`);
  });
}

start().catch((error) => {
  logger.error("Startup failed", error);
  process.exit(1);
});
