import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Sortable-ish id: base36 millisecond timestamp + random suffix, prefixed by type. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const bytes = randomBytes(10);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${time}${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
