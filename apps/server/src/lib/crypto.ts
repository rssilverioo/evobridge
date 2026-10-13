import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1';

/**
 * Encrypts provider credentials and retained payloads at rest.
 * Format: v1.<iv b64url>.<tag b64url>.<ciphertext b64url>
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
    this.#key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.#key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
  }

  decrypt(sealed: string): string {
    const [prefix, iv, tag, data] = sealed.split('.');
    if (prefix !== PREFIX || !iv || !tag || data === undefined) throw new Error('Unrecognized ciphertext format');
    const decipher = createDecipheriv(ALGO, this.#key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(sealed: string): T {
    return JSON.parse(this.decrypt(sealed)) as T;
  }
}

/** Parses ENCRYPTION_KEY: 64 hex chars or base64 of 32 bytes. */
export function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const b = Buffer.from(trimmed, 'base64');
  if (b.length === 32) return b;
  throw new Error('ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or base64');
}

/**
 * Uses ENCRYPTION_KEY when provided; otherwise generates one on first boot and keeps it
 * next to the database, so a single Docker volume holds everything needed to restart.
 */
export function loadOrCreateKey(dataDir: string, fromEnv: string | undefined): { key: Buffer; source: 'env' | 'file' | 'generated' } {
  if (fromEnv) return { key: parseKey(fromEnv), source: 'env' };
  const file = path.join(dataDir, 'encryption.key');
  if (fs.existsSync(file)) return { key: parseKey(fs.readFileSync(file, 'utf8')), source: 'file' };
  const key = randomBytes(32);
  fs.writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  return { key, source: 'generated' };
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** "abcdef123456ghij" -> "abcd••••ghij" */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••••••';
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}
