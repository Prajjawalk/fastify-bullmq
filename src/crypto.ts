/**
 * AES-256-GCM encryption helpers for sensitive WhatsApp data.
 *
 * Format of encrypted strings: `enc:v1:<base64(iv + ciphertext + authTag)>`
 * - iv (nonce): 12 bytes
 * - authTag: 16 bytes (appended after ciphertext)
 *
 * The `enc:v1:` prefix lets readers detect encrypted vs plaintext values
 * (for backwards compatibility with pre-encryption data).
 *
 * Master key is read from `WHATSAPP_ENCRYPTION_KEY` env var (64 hex chars = 32 bytes).
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PREFIX = 'enc:v1:';

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const hex = process.env.WHATSAPP_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'WHATSAPP_ENCRYPTION_KEY env var is not set. Generate a 32-byte hex key with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (hex.length !== 64) {
    throw new Error(
      `WHATSAPP_ENCRYPTION_KEY must be 64 hex chars (32 bytes), got ${hex.length} chars`
    );
  }
  cachedKey = Buffer.from(hex, 'hex');
  return cachedKey;
}

/**
 * Encrypt a UTF-8 string. Returns `enc:v1:<base64>`.
 * Returns null/undefined unchanged.
 */
export function encrypt(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined) return null;
  if (plaintext === '') return '';

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const payload = Buffer.concat([iv, encrypted, authTag]);
  return PREFIX + payload.toString('base64');
}

/**
 * Decrypt a value. If the value doesn't start with `enc:v1:`, returns it as-is
 * (allows reading legacy plaintext data during migration).
 */
export function decrypt(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value === '') return '';
  if (!value.startsWith(PREFIX)) return value;

  try {
    const payload = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = payload.subarray(0, IV_LENGTH);
    const authTag = payload.subarray(payload.length - AUTH_TAG_LENGTH);
    const ciphertext = payload.subarray(IV_LENGTH, payload.length - AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch (err) {
    console.error('Failed to decrypt value:', err);
    return null;
  }
}

/**
 * Encrypt a Buffer (for Baileys auth file contents).
 * Returns a Buffer that can be written directly to disk.
 */
export function encryptBuffer(plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]);
}

/**
 * Decrypt a Buffer that was encrypted with encryptBuffer().
 */
export function decryptBuffer(encrypted: Buffer): Buffer {
  const iv = encrypted.subarray(0, IV_LENGTH);
  const authTag = encrypted.subarray(encrypted.length - AUTH_TAG_LENGTH);
  const ciphertext = encrypted.subarray(IV_LENGTH, encrypted.length - AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
