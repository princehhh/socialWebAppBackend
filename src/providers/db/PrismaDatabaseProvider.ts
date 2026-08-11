import { PrismaClient } from "@prisma/client";
import { IDatabaseProvider } from "./IDatabaseProvider";

export class PrismaDatabaseProvider implements IDatabaseProvider {
  private client: PrismaClient;

  constructor() {
    this.client = new PrismaClient();
  }

  async connect(): Promise<void> {
    await this.client.$connect();
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  getClient(): PrismaClient {
    return this.client;
  }
}
