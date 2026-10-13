/**
 * Formatting between Chatwoot (Markdown) and WhatsApp (*bold* _italic_ ~strike~ ```mono```).
 */

const BOLD = '\u0000B\u0000';

/** Chatwoot Markdown -> WhatsApp. */
export function markdownToWhatsApp(input: string): string {
  let s = input.replace(/\r\n/g, '\n');
  // Code blocks and inline code pass through; WhatsApp understands ``` and `.
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, `${BOLD}$1${BOLD}`); // **bold**
  s = s.replace(/__([^_\n]+?)__/g, `${BOLD}$1${BOLD}`); // __bold__
  s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\w)/g, '$1_$2_'); // *italic*
  s = s.split(BOLD).join('*');
  s = s.replace(/~~([^~\n]+?)~~/g, '~$1~'); // ~~strike~~
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => (text === url ? url : `${text} (${url})`));
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '*$1*'); // headings
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, '$1'); // markdown escapes
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** WhatsApp -> Chatwoot Markdown. */
export function whatsAppToMarkdown(input: string): string {
  let s = input;
  s = s.replace(/(^|[\s(])\*([^*\n]+?)\*(?=$|[\s).,!?:;])/g, `$1${BOLD}$2${BOLD}`);
  s = s.replace(/(^|[\s(])~([^~\n]+?)~(?=$|[\s).,!?:;])/g, '$1~~$2~~');
  return s.split(BOLD).join('**');
}

/** Mime type -> file extension for attachments that arrive without a name. */
export function extensionFor(mimetype: string | null | undefined, fallback = 'bin'): string {
  const m = (mimetype ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/webm': 'webm',
    'application/pdf': 'pdf',
  };
  return known[m] ?? m.split('/')[1]?.replace(/[^a-z0-9]/g, '').slice(0, 8) ?? fallback;
}

/** Brazilian mobile numbers exist with and without the 9th digit; WhatsApp may use either. */
export function brazilVariants(digits: string): string[] {
  const out = [digits];
  if (!digits.startsWith('55')) return out;
  if (digits.length === 13 && digits[4] === '9') out.push(digits.slice(0, 4) + digits.slice(5));
  if (digits.length === 12 && /[6-9]/.test(digits[4] ?? '')) out.push(`${digits.slice(0, 4)}9${digits.slice(4)}`);
  return out;
}

export const waid = (id: string) => `WAID:${id}`;
