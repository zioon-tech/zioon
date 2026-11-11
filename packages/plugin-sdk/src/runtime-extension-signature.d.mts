export type SignedRuntimeExtension = {
  timestamp: string; id: string; body: string; signature?: string;
};
export function signRuntimeExtension(secret: string, input: SignedRuntimeExtension): string;
export function verifyRuntimeExtension(secret: string, input: SignedRuntimeExtension,
  options?: { now?: number; toleranceMs?: number }): boolean;
export function parseRuntimeHookRequest(secret: string,
  input: { body: string; headers: Record<string, string | string[] | undefined> },
  options?: { now?: number; toleranceMs?: number }): {
    context: Record<string, unknown>; timestamp: string; id: string;
  };
export function signedRuntimeHookResponse(secret: string,
  request: { timestamp: string; id: string }, decision?: unknown): {
    response: { schemaVersion: number; decision: unknown }; signature: string;
  };
