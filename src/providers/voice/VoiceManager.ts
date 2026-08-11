import { IVoiceProvider, VoiceSessionResult } from "./IVoiceProvider";
import { LiveKitAdapter } from "./LiveKitAdapter";
import { ZegoCloudAdapter } from "./ZegoCloudAdapter";
import { AgoraAdapter } from "./AgoraAdapter";

export class VoiceManager {
  private activeProvider: IVoiceProvider;

  constructor(activeTarget: string) {
    if (activeTarget === "LIVEKIT_PRIMARY") {
      this.activeProvider = new LiveKitAdapter();
    } else if (activeTarget === "ZEGOCLOUD_SECONDARY") {
      this.activeProvider = new ZegoCloudAdapter();
    } else {
      this.activeProvider = new AgoraAdapter();
    }
  }

  async requestSession(roomId: string, userId: string): Promise<VoiceSessionResult> {
    return this.activeProvider.createToken(roomId, userId);
  }
}
