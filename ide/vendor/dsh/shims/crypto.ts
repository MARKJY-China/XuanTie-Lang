// node:crypto → WebCrypto. 语义等价(同为 CSPRNG UUIDv4)。
export function randomUUID(): string {
  return globalThis.crypto.randomUUID()
}
