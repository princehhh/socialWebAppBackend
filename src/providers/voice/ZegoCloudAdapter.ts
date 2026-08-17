import { IVoiceProvider, VoiceSessionOptions, VoiceSessionResult } from "./IVoiceProvider";

export class ZegoCloudAdapter implements IVoiceProvider {
  async createToken(roomId: string, userId: string, options: VoiceSessionOptions): Promise<VoiceSessionResult> {
    return {
      providerId: "ZEGOCLOUD_SECONDARY",
      roomId,
      token: `zego_mock_${userId}_${Date.now()}`,
      callType: options.callType
    };
  }
}
