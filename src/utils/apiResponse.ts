export interface ApiEnvelope<T> {
  success: boolean;
  message: string;
  data?: T;
  errorCode?: string;
}

export function ok<T>(message: string, data?: T): ApiEnvelope<T> {
  return { success: true, message, data };
}

export function fail(message: string, errorCode: string): ApiEnvelope<never> {
  return { success: false, message, errorCode };
}
