import { IVoiceProvider, VoiceSessionResult } from "./IVoiceProvider";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";

export class LiveKitAdapter implements IVoiceProvider {
  async createToken(roomId: string, userId: string): Promise<VoiceSessionResult> {
    if (env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const token = jwt.sign(
        {
          iss: env.LIVEKIT_API_KEY,
          sub: userId,
          nbf: nowSeconds,
          exp: nowSeconds + 60 * 60,
          video: {
            roomJoin: true,
            room: roomId,
            canPublish: true,
            canSubscribe: true
          }
        },
        env.LIVEKIT_API_SECRET,
        { algorithm: "HS256" }
      );

      return {
        providerId: "LIVEKIT_PRIMARY",
        roomId,
        token,
        serverUrl: env.LIVEKIT_HOST
      };
    }

    return {
      providerId: "LIVEKIT_PRIMARY",
      roomId,
      token: `livekit_mock_${userId}_${Date.now()}`,
      serverUrl: env.LIVEKIT_HOST
    };
  }
}
