import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { passwordProblem } from '@evobridge/shared';
import { describe, expect, it } from 'vitest';
import { brazilVariants, markdownToWhatsApp, whatsAppToMarkdown } from '../src/bridge/format.js';
import { backoffMs } from '../src/bridge/queue.js';
import { SecretBox, loadOrCreateKey, maskSecret } from '../src/lib/crypto.js';
import { ProviderError } from '../src/lib/errors.js';
import { assertSafeUrl, isBlockedAddress } from '../src/lib/http.js';
import { redact, redactUrl } from '../src/lib/redact.js';
import { verifyChatwootSignature } from '../src/providers/chatwoot/client.js';
import { createHmac } from 'node:crypto';
import { generateWaMessageId } from '../src/providers/evolution-go/client.js';
import { extractContent, normalizeEvolutionEvent, resolveChat } from '../src/providers/evolution-go/normalize.js';

describe('encryption at rest', () => {
  const box = new SecretBox(Buffer.alloc(32, 7));

  it('round-trips and never stores plaintext', () => {
    const sealed = box.encrypt('example-secret-value');
    expect(sealed).not.toContain('supersecret');
    expect(box.decrypt(sealed)).toBe('example-secret-value');
    expect(box.encrypt('x')).not.toBe(box.encrypt('x'));
  });

  it('rejects tampered ciphertext', () => {
    const sealed = box.encrypt('hello');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('jello').toString('base64url');
    expect(() => box.decrypt(parts.join('.'))).toThrow();
  });

  it('rejects a different key', () => {
    const other = new SecretBox(Buffer.alloc(32, 8));
    expect(() => other.decrypt(box.encrypt('hello'))).toThrow();
  });

  it('generates a key once and reuses it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evobridge-key-'));
    const first = loadOrCreateKey(dir, undefined);
    const second = loadOrCreateKey(dir, undefined);
    expect(first.source).toBe('generated');
    expect(second.source).toBe('file');
    expect(second.key.equals(first.key)).toBe(true);
    expect(fs.statSync(path.join(dir, 'encryption.key')).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true });
  });

  it('masks secrets for display', () => {
    expect(maskSecret('abcdefghijklmnop')).toBe('abcd••••mnop');
    expect(maskSecret('short')).toBe('••••••••');
  });
});

describe('password rule', () => {
  it('needs 8 chars, a number and a special character', () => {
    expect(passwordProblem('abc')).toMatch(/8 characters/);
    expect(passwordProblem('abcdefgh')).toMatch(/number/);
    expect(passwordProblem('abcdefg1')).toMatch(/special/);
    expect(passwordProblem('abcdef 1')).toMatch(/special/);
    expect(passwordProblem('abcdef#1')).toBeNull();
  });
});

describe('SSRF guard', () => {
  it('blocks private, loopback, CGNAT and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '172.16.4.4', '100.64.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) {
      expect(isBlockedAddress(ip, false), ip).toBe(true);
    }
    expect(isBlockedAddress('8.8.8.8', false)).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111', false)).toBe(false);
  });

  it('allows private networks only when opted in, never cloud metadata', () => {
    expect(isBlockedAddress('10.0.0.5', true)).toBe(false);
    expect(isBlockedAddress('169.254.169.254', true)).toBe(true);
  });

  it('validates URL shape', () => {
    expect(() => assertSafeUrl('ftp://example.com', false)).toThrow(ProviderError);
    expect(() => assertSafeUrl('http://user:pass@example.com', false)).toThrow(/credentials/);
    expect(() => assertSafeUrl('http://localhost:8080', false)).toThrow(/private/);
    expect(() => assertSafeUrl('http://127.0.0.1', false)).toThrow(/private/);
    expect(assertSafeUrl('https://evo.example.com/x', false).host).toBe('evo.example.com');
  });
});

describe('log redaction', () => {
  it('hides credentials and media', () => {
    const out = redact({ apikey: 'k', nested: { instanceToken: 't', text: 'hi' }, Message: { base64: 'x'.repeat(5000) } }) as Record<string, any>;
    expect(out.apikey).toBe('[redacted]');
    expect(out.nested.instanceToken).toBe('[redacted]');
    expect(out.nested.text).toBe('hi');
    expect(out.Message.base64).toBe('[redacted]');
    expect(redactUrl('/hooks/evolution/con_1/supersecret')).toBe('/hooks/evolution/con_1/••••');
  });
});

describe('formatting', () => {
  it('converts Chatwoot markdown to WhatsApp', () => {
    expect(markdownToWhatsApp('**bold** and *italic* and ~~gone~~')).toBe('*bold* and _italic_ and ~gone~');
    expect(markdownToWhatsApp('[site](https://x.com)')).toBe('site (https://x.com)');
    expect(markdownToWhatsApp('price \\* 2')).toBe('price * 2');
  });

  it('converts WhatsApp formatting to markdown', () => {
    expect(whatsAppToMarkdown('*promo* hoje ~caro~')).toBe('**promo** hoje ~~caro~~');
    expect(whatsAppToMarkdown('2 * 3 = 6')).toBe('2 * 3 = 6');
  });

  it('knows both Brazilian mobile forms', () => {
    expect(brazilVariants('5511987654321')).toEqual(['5511987654321', '551187654321']);
    expect(brazilVariants('553187654321')).toEqual(['553187654321', '5531987654321']);
    expect(brazilVariants('14155550100')).toEqual(['14155550100']);
  });
});

describe('Evolution Go payloads', () => {
  const base = { IsGroup: false, ID: 'ABC', Type: 'text', Timestamp: '2026-10-13T12:00:00Z' };

  it('incoming DM after LID swap: phone chat, LID learned', () => {
    const chat = resolveChat({ ...base, Chat: '5511999999999@s.whatsapp.net', Sender: '5511999999999@s.whatsapp.net', SenderAlt: '123456789012345@lid', IsFromMe: false });
    expect(chat).toEqual({ chatJid: '5511999999999@s.whatsapp.net', phone: '5511999999999', lid: '123456789012345@lid', isGroup: false });
  });

  it('message typed on the phone in a LID chat uses RecipientAlt for the phone', () => {
    const chat = resolveChat({ ...base, Chat: '123456789012345@lid', Sender: '5511900000001:7@s.whatsapp.net', RecipientAlt: '5511999999999@s.whatsapp.net', IsFromMe: true });
    expect(chat.chatJid).toBe('5511999999999@s.whatsapp.net');
    expect(chat.lid).toBe('123456789012345@lid');
  });

  it('never invents a phone number for a bare LID', () => {
    const chat = resolveChat({ ...base, Chat: '123456789012345@lid', Sender: '123456789012345@lid', IsFromMe: false });
    expect(chat).toEqual({ chatJid: '123456789012345@lid', phone: null, lid: '123456789012345@lid', isGroup: false });
  });

  it('strips device suffixes', () => {
    const chat = resolveChat({ ...base, Chat: '5511999999999:12@s.whatsapp.net', Sender: '5511999999999:12@s.whatsapp.net', IsFromMe: false });
    expect(chat.chatJid).toBe('5511999999999@s.whatsapp.net');
  });

  it('classifies revoke, edit and reaction', () => {
    const env = (Message: unknown, extra: Record<string, unknown> = {}) => ({
      event: 'Message',
      data: { Info: { ...base, Chat: '5511@s.whatsapp.net', Sender: '5511@s.whatsapp.net', IsFromMe: false }, Message, ...extra },
    });
    expect(normalizeEvolutionEvent(env({ protocolMessage: { type: 0, key: { ID: 'ORIG' } } }))).toMatchObject({ type: 'revoke', targetId: 'ORIG' });
    expect(normalizeEvolutionEvent(env({ protocolMessage: { type: 14, key: { ID: 'ORIG' }, editedMessage: { conversation: 'fixed' } } }, { IsEdit: true }))).toMatchObject({
      type: 'edit',
      targetId: 'ORIG',
      text: 'fixed',
    });
    expect(normalizeEvolutionEvent(env({ reactionMessage: { key: { ID: 'ORIG' }, text: '👍' } }))).toMatchObject({ type: 'reaction', emoji: '👍' });
  });

  it('reads media injected by Evolution Go and unwraps wrappers', () => {
    const c = extractContent({ ephemeralMessage: { message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg' } } }, base64: 'AAAA', mimetype: 'image/jpeg' });
    expect(c.kind).toBe('image');
    expect(c.text).toBe('look');
    expect(c.inline?.base64).toBe('AAAA');
    const d = extractContent({ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'nota.pdf', caption: 'segue', mimetype: 'application/pdf' } } } });
    expect(d).toMatchObject({ kind: 'document', fileName: 'nota.pdf', text: 'segue' });
  });

  it('turns receipts into delivered/read and ignores the rest', () => {
    const r = normalizeEvolutionEvent({ event: 'Receipt', state: 'Read', data: { Chat: '5511@s.whatsapp.net', Sender: '', IsFromMe: false, IsGroup: false, MessageIDs: ['A', 'B'] } });
    expect(r).toEqual({ type: 'receipt', chatJid: '5511@s.whatsapp.net', messageIds: ['A', 'B'], state: 'read' });
    expect(normalizeEvolutionEvent({ event: 'Presence', data: {} }).type).toBe('ignored');
    expect(normalizeEvolutionEvent({ event: 'Message', data: { Info: { ...base, Chat: 'status@broadcast', Sender: 'x@s.whatsapp.net', IsFromMe: false } } }).type).toBe('ignored');
  });

  it('generates WhatsApp-format message ids', () => {
    expect(generateWaMessageId()).toMatch(/^3EB0[0-9A-F]{18}$/);
  });
});

describe('Chatwoot webhook signature', () => {
  const secret = 's3cret';
  const body = Buffer.from('{"event":"message_created"}');
  const sign = (ts: string) => `sha256=${createHmac('sha256', secret).update(`${ts}.${body.toString()}`).digest('hex')}`;

  it('accepts a valid, fresh signature', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifyChatwootSignature(secret, body, ts, sign(ts))).toBe(true);
  });

  it('rejects wrong secret, stale timestamp, missing headers', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifyChatwootSignature('other', body, ts, sign(ts))).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifyChatwootSignature(secret, body, old, sign(old))).toBe(false);
    expect(verifyChatwootSignature(secret, body, undefined, undefined)).toBe(false);
  });
});

describe('retry backoff', () => {
  it('grows exponentially, is capped, and honors Retry-After', () => {
    expect(backoffMs(1)).toBeLessThanOrEqual(2000);
    expect(backoffMs(5)).toBeGreaterThanOrEqual(16000);
    expect(backoffMs(50)).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(backoffMs(1, 30_000)).toBe(30_000);
  });
});
