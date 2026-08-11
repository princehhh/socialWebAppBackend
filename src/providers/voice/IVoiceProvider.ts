export interface VoiceSessionResult {
  token: string;
  providerId: string;
  roomId: string;
  serverUrl?: string;
}

export interface IVoiceProvider {
  createToken(roomId: string, userId: string): Promise<VoiceSessionResult>;
}
