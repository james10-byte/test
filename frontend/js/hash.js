export async function sha256Hex(buffer, cryptoSource = globalThis.crypto) {
  if (!cryptoSource?.subtle) return null;
  const digest = await cryptoSource.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
