export function personalEntryAllowed(input: { hasBridge: boolean; protocol: string; hostname: string }) {
  return input.hasBridge || input.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(input.hostname);
}
