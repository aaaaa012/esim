import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GmailChannel } from './gmail.channel.js';
import { ResendChannel } from './resend.channel.js';

function decodeRawMime(rawBase64url: string): string {
  return Buffer.from(rawBase64url, 'base64url').toString('utf8');
}

describe('GmailChannel MIME construction', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.NOTIFICATION_MODE = 'live';
    process.env.GMAIL_CLIENT_ID = 'client-id';
    process.env.GMAIL_CLIENT_SECRET = 'client-secret';
    process.env.GMAIL_REFRESH_TOKEN = 'refresh-token';
    process.env.GMAIL_FROM_ADDRESS = 'noreply@visacompass.example';
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      if (String(url).includes('oauth2')) {
        return new Response(JSON.stringify({ access_token: 'token-1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('stays simulated outside live mode without touching the network', async () => {
    process.env.NOTIFICATION_MODE = 'simulator';
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await new GmailChannel().send({ to: 'a@b.c', subject: 'S', text: 'T' });
    expect(result.simulated).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends plain text only when no html or attachment is provided', async () => {
    let captured = '';
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (!String(url).includes('oauth2')) captured = String(init?.body ?? '');
      return new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 });
    }) as unknown as typeof fetch;
    await new GmailChannel().send({ to: 'to@x.y', subject: 'Update', text: 'plain body' });
    const mime = decodeRawMime(JSON.parse(captured).raw as string);
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mime).toContain('plain body');
    expect(mime).not.toContain('multipart');
  });

  it('wraps text and html in multipart/alternative so rich clients render the branded version', async () => {
    let captured = '';
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (!String(url).includes('oauth2')) captured = String(init?.body ?? '');
      return new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 });
    }) as unknown as typeof fetch;
    await new GmailChannel().send({ to: 'to@x.y', subject: 'Ready', text: 'plain fallback', html: '<div>branded</div>' });
    const mime = decodeRawMime(JSON.parse(captured).raw as string);
    expect(mime).toContain('multipart/mixed');
    expect(mime).toContain('multipart/alternative');
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mime).toContain('Content-Type: text/html; charset=UTF-8');
    expect(mime).toContain('plain fallback');
    expect(mime).toContain('<div>branded</div>');
    const boundaries = mime.match(/boundary="([^"]+)"/g) ?? [];
    expect(boundaries.length).toBeGreaterThanOrEqual(2);
  });

  it('attaches the QR image alongside the alternative bodies', async () => {
    let captured = '';
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (!String(url).includes('oauth2')) captured = String(init?.body ?? '');
      return new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 });
    }) as unknown as typeof fetch;
    await new GmailChannel().send({
      to: 'to@x.y', subject: 'QR', text: 'body', html: '<div>body</div>',
      attachment: { filename: 'VC-1-esim-qr.png', contentType: 'image/png', base64: Buffer.from('png-bytes').toString('base64') },
    });
    const mime = decodeRawMime(JSON.parse(captured).raw as string);
    expect(mime).toContain('Content-Type: image/png');
    expect(mime).toContain('filename="VC-1-esim-qr.png"');
    expect(mime).toContain('Content-Disposition: attachment');
    expect(mime.indexOf('multipart/alternative')).toBeLessThan(mime.indexOf('image/png'));
  });

  it('strips header injection attempts from addresses and subjects', async () => {
    let captured = '';
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (!String(url).includes('oauth2')) captured = String(init?.body ?? '');
      return new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 });
    }) as unknown as typeof fetch;
    await new GmailChannel().send({ to: 'victim@x.y\r\nBcc: attacker@evil.z', subject: 'Hello\r\nX-Evil: 1', text: 'hi' });
    const mime = decodeRawMime(JSON.parse(captured).raw as string);
    const headerLines = mime.split('\r\n').slice(0, 6);
    expect(headerLines.some((line) => /^(bcc|x-evil):/i.test(line))).toBe(false);
    expect(mime).toContain('attacker@evil.z');
  });

  it('throws a service error when the OAuth refresh fails', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      if (String(url).includes('oauth2')) return new Response('{"error":"invalid_grant"}', { status: 400 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await expect(new GmailChannel().send({ to: 'a@b.c', subject: 'S', text: 'T' })).rejects.toThrow(/OAuth refresh failed/);
  });
});

describe('ResendChannel request contract', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.NOTIFICATION_MODE = 'live';
    process.env.RESEND_API_KEY = 're_live_key';
    process.env.EMAIL_FROM_ADDRESS = 'noreply@visacompass.example';
    process.env.EMAIL_REPLY_TO = 'support@visacompass.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('passes text, html, reply_to and attachments in the provider payload', async () => {
    let capturedBody = '';
    let capturedAuth = '';
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '');
      capturedAuth = String((init?.headers as Record<string, string>)?.authorization ?? '');
      return new Response(JSON.stringify({ id: 'email-1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await new ResendChannel().send({
      to: 'customer@x.y',
      subject: 'Your eSIM is ready',
      text: 'plain',
      html: '<div>rich</div>',
      attachment: { filename: 'qr.png', contentType: 'image/png', base64: 'QUJD' },
    });
    expect(result.simulated).toBe(false);
    expect(capturedAuth).toBe('Bearer re_live_key');
    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(body.from).toBe('noreply@visacompass.example');
    expect(body.subject).toBe('Your eSIM is ready');
    expect(body.html).toBe('<div>rich</div>');
    expect(body.reply_to).toEqual(['support@visacompass.example']);
    expect(body.attachments).toEqual([{ filename: 'qr.png', content: 'QUJD', content_type: 'image/png' }]);
  });

  it('supports a comma-separated reply-to list and omits html when absent', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ id: 'email-2' }), { status: 200 });
    }) as unknown as typeof fetch;
    await new ResendChannel().send({ to: 'a@b.c', subject: 'S', text: 'T', replyTo: 'one@x.y, two@x.z' });
    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(body.reply_to).toEqual(['one@x.y', 'two@x.z']);
    expect('html' in body).toBe(false);
  });

  it('surfaces provider errors with their detail for server-side logs', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'domain not verified' }), { status: 403 })) as unknown as typeof fetch;
    await expect(new ResendChannel().send({ to: 'a@b.c', subject: 'S', text: 'T' })).rejects.toThrow(/domain not verified/);
  });

  it('returns a simulated result outside live mode without any network call', async () => {
    process.env.NOTIFICATION_MODE = 'simulator';
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await new ResendChannel().send({ to: 'a@b.c', subject: 'S', text: 'T' });
    expect(result.simulated).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
