import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { runtimeConfig } from "../config/runtime";
import { fail } from "../utils/apiResponse";

interface SessionPayload {
  userId: string;
  sessionId: string;
}

export function authMiddleware(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return res.status(401).json(fail("Missing authorization token", "AUTH_REQUIRED"));
    }

    const token = auth.replace("Bearer ", "").trim();

    try {
      const decoded = jwt.verify(token, runtimeConfig.env.JWT_SECRET) as SessionPayload;
      const session = await prisma.session.findUnique({ where: { id: decoded.sessionId } });

      if (!session || session.expiresAt < new Date()) {
        return res.status(401).json(fail("Session expired", "SESSION_EXPIRED"));
      }

      await prisma.user.update({
        where: { id: decoded.userId },
        data: { lastSeenAt: new Date() }
      });

      req.authenticatedUserId = decoded.userId;
      req.authToken = token;
      return next();
    } catch {
      return res.status(401).json(fail("Invalid authorization token", "INVALID_TOKEN"));
    }
  };
}
