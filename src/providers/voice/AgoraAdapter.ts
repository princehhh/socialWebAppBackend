import { IVoiceProvider, VoiceSessionResult } from "./IVoiceProvider";

export class AgoraAdapter implements IVoiceProvider {
  async createToken(roomId: string, userId: string): Promise<VoiceSessionResult> {
    return {
      providerId: "AGORA_TERTIARY",
      roomId,
      token: `agora_mock_${userId}_${Date.now()}`
    };
  }
}
