import { getDomain, getDomainWithoutSuffix } from 'tldts';

/**
 * Does a card authorization's merchant belong to the merchant a spend was
 * reserved for (AU-26)? Card networks report a free-text descriptor and, only
 * sometimes, a URL, so this cannot be exact; it must not be a substring test
 * either, which let `a.co` ("aco") admit "TACO BELL".
 *
 * A reservation for a domain matches a merchant URL on the same registrable
 * domain; with no URL, the descriptor must carry the domain's name as a whole
 * word ("GITHUB, INC." for github.com). A free-text reservation needs each of
 * its words, whole, in the descriptor. An unbound reservation matches anything;
 * a bound one never matches a merchant that reports nothing.
 */
export function paymentMerchantMatches(reserved: unknown, merchant: { name?: unknown; url?: unknown }): boolean {
  const expected = String(reserved ?? '').trim();
  if (!expected) return true;
  const descriptor = words(merchant.name);
  const domain = registrableDomain(expected);
  if (domain) {
    const reportedDomain = registrableDomain(merchant.url);
    if (reportedDomain) return reportedDomain === domain;
    const brand = getDomainWithoutSuffix(domain, { allowPrivateDomains: true });
    return !!brand && brand.split('.').every((label) => words(label).every((word) => descriptor.includes(word)));
  }
  const required = words(expected);
  return required.length > 0 && required.every((word) => descriptor.includes(word));
}

function words(value: unknown): string[] {
  return String(value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function registrableDomain(value: unknown): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw || /\s/.test(raw)) return undefined;
  try {
    const host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
    return host.includes('.') ? getDomain(host, { allowPrivateDomains: true }) ?? undefined : undefined;
  } catch { return undefined; }
}
