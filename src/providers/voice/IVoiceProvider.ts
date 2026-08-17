export type CallMediaType = "VOICE" | "VIDEO";

export interface VoiceSessionOptions {
  callType: CallMediaType;
}

export interface VoiceSessionResult {
  token: string;
  providerId: string;
  roomId: string;
  serverUrl?: string;
  callType: CallMediaType;
}

export interface IVoiceProvider {
  createToken(roomId: string, userId: string, options: VoiceSessionOptions): Promise<VoiceSessionResult>;
}
