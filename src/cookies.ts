export const COOKIE_ACCESS = 'access_token';

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split('; ')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx)] = decodeURIComponent(part.slice(idx + 1));
  }
  return out;
}
