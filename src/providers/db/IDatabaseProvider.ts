import { PrismaClient } from "@prisma/client";

export interface IDatabaseProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<boolean>;
  getClient(): PrismaClient;
}
