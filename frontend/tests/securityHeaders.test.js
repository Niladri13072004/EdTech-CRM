import { describe, expect, it } from 'vitest';
import vercelConfig from '../vercel.json' with { type: 'json' };

const headers = Object.fromEntries(
  vercelConfig.headers[0].headers.map(({ key, value }) => [key, value]),
);
const csp = Object.fromEntries(
  headers['Content-Security-Policy'].split(';').map((directive) => {
    const [name, ...values] = directive.trim().split(/\s+/);
    return [name, values];
  }),
);

describe('production security headers (vercel.json)', () => {
  it('applies to every path', () => {
    expect(vercelConfig.headers[0].source).toBe('/(.*)');
  });

  it('sends a restrictive Content-Security-Policy', () => {
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    expect(csp['connect-src']).toEqual(["'self'"]);
    // Only style *attributes* (chart bar widths) may be inline; no inline scripts or <style>.
    expect(csp['style-src']).toEqual(["'self'"]);
    expect(csp['style-src-attr']).toEqual(["'unsafe-inline'"]);
    expect(headers['Content-Security-Policy']).not.toMatch(
      /unsafe-eval|script-src[^;]*unsafe-inline|\*/,
    );
  });

  it('sends HSTS, nosniff, frame and referrer protections', () => {
    expect(headers['Strict-Transport-Security']).toMatch(/max-age=\d{8,}/);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
  });

  it('serves the SPA for client routes but not for built assets', () => {
    const apiRewrite = vercelConfig.rewrites.find(({ source }) => source === '/api/:path*');
    const spaRewrite = vercelConfig.rewrites.find(
      ({ destination }) => destination === '/index.html',
    );

    expect(apiRewrite).toBeDefined();
    expect(apiRewrite.destination).toMatch(/^https:\/\/.+\/api\/:path\*$/);
    expect(vercelConfig.rewrites.indexOf(apiRewrite)).toBeLessThan(
      vercelConfig.rewrites.indexOf(spaRewrite),
    );
    expect(spaRewrite).toBeDefined();

    const pattern = new RegExp(
      `^${spaRewrite.source.replace('/((?!', '/(?!(').replace(').*)', ')).*')}$`,
    );
    expect(pattern.test('/admin/dashboard')).toBe(true);
    expect(pattern.test('/assets/index-abc.js')).toBe(false);
  });
});
