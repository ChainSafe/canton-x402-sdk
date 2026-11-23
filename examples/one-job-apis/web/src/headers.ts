/** Decode x402 header values for the trace panel. Display only. */

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function decodeHeaderJson(headerValue: string): unknown {
  const raw = new TextDecoder().decode(base64ToBytes(headerValue));
  return JSON.parse(raw) as unknown;
}