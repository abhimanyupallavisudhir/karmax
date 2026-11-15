import crypto from 'node:crypto';
import { humanBrowser, SOURCE_GROUPS, sourceGroup, utcDay, type SiteAnalyticsCount, type SiteAnalyticsRow,
  type SiteVisitorMark, type SourceGroup } from '../domain/site-analytics.js';

/**
 * First-party, cookieless web analytics of the public site (wiki
 * features/site-analytics). The gateway counts crawler fetches itself and a
 * person's page views from the console's beacon; this keeps them in memory
 * and writes them every few seconds, so a burst of traffic is a few writes,
 * not one per request.
 *
 * A visitor is `sha256(salt ‖ address ‖ User-Agent)` under a salt random per
 * UTC day and shared by every gateway process through the store; the day's
 * salt and hashes are deleted within 48 hours, so nothing recognises a
 * person on another day and no address is stored. Addresses live only in
 * memory until the next write.
 */

const DAY = 86_400_000;
/** The pages whose view means the person opened sign-up (one page holds both forms). */
const SIGNUP_PATHS = new Set(['/signup', '/login']);
/** Beyond these, a batch the database has not taken drops new keys rather than grow without bound. */
const MAX_COUNT_KEYS = 50_000;
const MAX_PEOPLE = 100_000;

export interface SiteAnalyticsStore {
  siteAnalyticsSalt(day: string, candidate: string): Promise<string>;
  recordSiteAnalytics(batch: { counts: SiteAnalyticsCount[]; visitors: SiteVisitorMark[] }): Promise<void>;
  pruneSiteVisitors(beforeDay: string): Promise<void>;
}

interface Person { day: string; ip: string; userAgent: string; path: string; source: string; signup?: string }

export class SiteAnalytics {
  private counts = new Map<string, SiteAnalyticsCount>();
  private people = new Map<string, Person>();
  /** Hashes this process already wrote today: not sent again. */
  private written = new Set<string>();
  private salts = new Map<string, string>();
  private prunedOn = '';
  private writing: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private limits = new Map<string, { count: number; until: number }>();
  private limitSweepAt = 0;
  private readonly now: () => number;
  private readonly flushEveryMs: number;
  private readonly rateLimit: { max: number; windowMs: number };

  constructor(private store: SiteAnalyticsStore, options: { now?: () => number; flushEveryMs?: number;
    /** Beacons one address may send in a window (default 60 a minute: a page a second). */
    rateLimit?: { max: number; windowMs: number } } = {}) {
    this.now = options.now ?? Date.now;
    this.flushEveryMs = options.flushEveryMs ?? 5_000;
    this.rateLimit = options.rateLimit ?? { max: 60, windowMs: 60_000 };
  }

  /** Whether `ip` may send another beacon now (counts this one). */
  admit(ip: string): boolean {
    const now = this.now();
    if (now >= this.limitSweepAt) {
      for (const [key, bucket] of this.limits) if (bucket.until <= now) this.limits.delete(key);
      this.limitSweepAt = now + this.rateLimit.windowMs;
    }
    let bucket = this.limits.get(ip);
    if (!bucket || bucket.until <= now) {
      if (!bucket && this.limits.size >= 100_000) return false;
      bucket = { count: 0, until: now + this.rateLimit.windowMs };
      this.limits.set(ip, bucket);
    }
    return ++bucket.count <= this.rateLimit.max;
  }

  /** A person's view of a public page (`path` canonical); `source` is where it
   * came from, '' for nowhere, null for another of the site's own pages. */
  view(input: { path: string; source: string | null; ip: string; userAgent: string }): 'counted' | 'ignored' {
    if (!humanBrowser(input.userAgent)) return 'ignored';
    const day = utcDay(this.now());
    this.count({ day, kind: 'view', path: input.path, source: '', n: 1 });
    const key = `${day}\n${input.ip}\n${input.userAgent}`;
    let person = this.people.get(key);
    if (!person && this.people.size < MAX_PEOPLE)
      this.people.set(key, person = { day, ip: input.ip, userAgent: input.userAgent, path: input.path, source: input.source ?? '' });
    if (person && !person.signup && SIGNUP_PATHS.has(input.path)) person.signup = input.path;
    return 'counted';
  }

  /** A known crawler fetched `path` of the public site. */
  crawl(crawler: string, path: string): void {
    this.count({ day: utcDay(this.now()), kind: 'crawl', path, source: crawler, n: 1 });
  }

  private count(entry: SiteAnalyticsCount) {
    const key = `${entry.day}\n${entry.kind}\n${entry.path}\n${entry.source}`;
    const existing = this.counts.get(key);
    if (existing) existing.n += entry.n;
    else if (this.counts.size < MAX_COUNT_KEYS) this.counts.set(key, { ...entry });
  }

  /** Write what is counted so far (one transaction), and delete expired salts and hashes. */
  flush(): Promise<void> {
    this.writing = this.writing.then(() => this.write()).catch((error) => {
      console.warn(`[site-analytics] write failed; kept for the next one: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.writing;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushEveryMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  private async salt(day: string): Promise<string> {
    let salt = this.salts.get(day);
    if (!salt) this.salts.set(day, salt = await this.store.siteAnalyticsSalt(day, crypto.randomBytes(32).toString('hex')));
    return salt;
  }

  private async write(): Promise<void> {
    const now = this.now();
    const today = utcDay(now);
    if (this.prunedOn !== today) {
      // Yesterday's hashes still tell who was counted before midnight UTC;
      // anything older goes, with its salt.
      const keep = utcDay(now - DAY);
      await this.store.pruneSiteVisitors(keep);
      for (const day of this.salts.keys()) if (day < keep) this.salts.delete(day);
      for (const key of this.written) if (key.slice(0, 10) < keep) this.written.delete(key);
      this.prunedOn = today;
    }
    if (!this.counts.size && !this.people.size) return;
    const counts = this.counts, people = this.people;
    this.counts = new Map();
    this.people = new Map();
    try {
      const visitors: SiteVisitorMark[] = [];
      for (const person of people.values()) {
        const hash = crypto.createHash('sha256').update(`${await this.salt(person.day)}\n${person.ip}\n${person.userAgent}`).digest('hex').slice(0, 32);
        const marks: SiteVisitorMark[] = [{ day: person.day, mark: '', hash, path: person.path, source: person.source }];
        if (person.signup) marks.push({ day: person.day, mark: 'signup', hash, path: person.signup, source: '' });
        visitors.push(...marks.filter((mark) => !this.written.has(`${mark.day}\n${mark.mark}\n${mark.hash}`)));
      }
      await this.store.recordSiteAnalytics({ counts: [...counts.values()], visitors });
      if (this.written.size > MAX_PEOPLE) this.written.clear();
      for (const mark of visitors) this.written.add(`${mark.day}\n${mark.mark}\n${mark.hash}`);
    } catch (error) {
      // Put the batch back under anything counted meanwhile.
      for (const entry of counts.values()) this.count(entry);
      for (const [key, person] of people) {
        const later = this.people.get(key);
        if (!later) { if (this.people.size < MAX_PEOPLE) this.people.set(key, person); }
        else { this.people.set(key, { ...person, signup: person.signup ?? later.signup }); }
      }
      throw error;
    }
  }
}

export interface SiteAnalyticsReportStore {
  siteAnalyticsRows(fromDay: string, toDay: string): Promise<SiteAnalyticsRow[]>;
  organizationFirstTasks(from: number, to: number): Promise<{ started: number[]; confirmed: number[] }>;
}

export const FUNNEL_STEPS = ['visitors', 'signups', 'accounts', 'firstTasks', 'firstConfirmed'] as const;

export interface SiteAnalyticsReport {
  from: string; to: string;
  totals: { visitors: number; views: number; signups: number; accounts: number; crawls: number };
  daily: Array<{ day: string; visitors: number; views: number; signups: number; accounts: number; firstTasks: number; firstConfirmed: number }>;
  pages: Array<{ path: string; views: number; entries: number }>;
  sources: { groups: Array<{ group: SourceGroup; label: string; visitors: number }>; hosts: Array<{ source: string; group: SourceGroup; visitors: number }> };
  crawlers: Array<{ name: string; fetches: number; pages: Array<{ path: string; fetches: number }> }>;
  funnel: Array<{ step: (typeof FUNNEL_STEPS)[number]; count: number }>;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A YYYY-MM-DD that is a real day, as UTC midnight in ms. */
export function parseDay(value: unknown): number | undefined {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && utcDay(ms) === value ? ms : undefined;
}

const LIST = 100;
const byCount = <T>(count: (item: T) => number, name: (item: T) => string) => (a: T, b: T) => count(b) - count(a) || name(a).localeCompare(name(b));

/** What the public site's visitors and crawlers did from `from` to `to` (UTC days, inclusive), and the sign-up funnel. */
export async function siteAnalyticsReport(store: SiteAnalyticsReportStore, options: { from: string; to: string;
  /** When each account was created (epoch ms); the identity service knows. */
  accountsCreated?: () => Promise<number[]> }): Promise<SiteAnalyticsReport> {
  const fromMs = parseDay(options.from), toMs = parseDay(options.to);
  if (fromMs === undefined || toMs === undefined || toMs < fromMs) throw new Error('from and to must be days (YYYY-MM-DD), from ≤ to');
  const days = Math.round((toMs - fromMs) / DAY) + 1;
  const daily = Array.from({ length: days }, (_, i) => ({ day: utcDay(fromMs + i * DAY),
    visitors: 0, views: 0, signups: 0, accounts: 0, firstTasks: 0, firstConfirmed: 0 }));
  const index = new Map(daily.map((entry, i) => [entry.day, i]));
  const at = (ms: number) => daily[index.get(utcDay(ms)) ?? -1];
  const end = toMs + DAY - 1;

  const [rows, firsts, accounts] = await Promise.all([
    store.siteAnalyticsRows(options.from, options.to),
    store.organizationFirstTasks(fromMs, end),
    options.accountsCreated?.() ?? Promise.resolve([] as number[]),
  ]);
  const pages = new Map<string, { path: string; views: number; entries: number }>();
  const page = (path: string) => pages.get(path) ?? pages.set(path, { path, views: 0, entries: 0 }).get(path)!;
  const sources = new Map<string, number>();
  const crawlers = new Map<string, Map<string, number>>();
  let crawls = 0;
  for (const row of rows) {
    const day = daily[index.get(row.day) ?? -1];
    if (!day) continue;
    if (row.kind === 'view') { day.views += row.count; page(row.path).views += row.count; }
    else if (row.kind === 'visitor') {
      day.visitors += row.count;
      page(row.path).entries += row.count;
      sources.set(row.source, (sources.get(row.source) ?? 0) + row.count);
    } else if (row.kind === 'signup') day.signups += row.count;
    else if (row.kind === 'crawl') {
      crawls += row.count;
      const paths = crawlers.get(row.source) ?? crawlers.set(row.source, new Map()).get(row.source)!;
      paths.set(row.path, (paths.get(row.path) ?? 0) + row.count);
    }
  }
  for (const ms of accounts) if (ms >= fromMs && ms <= end) at(ms)!.accounts++;
  for (const ms of firsts.started) at(ms)!.firstTasks++;
  for (const ms of firsts.confirmed) at(ms)!.firstConfirmed++;

  const sum = (field: keyof (typeof daily)[number]) => daily.reduce((total, entry) => total + Number(entry[field]), 0);
  const totals = { visitors: sum('visitors'), views: sum('views'), signups: sum('signups'), accounts: sum('accounts'), crawls };
  const groups = new Map<SourceGroup, number>();
  const hosts = [...sources].map(([source, visitors]) => ({ source, group: sourceGroup(source), visitors }));
  for (const host of hosts) groups.set(host.group, (groups.get(host.group) ?? 0) + host.visitors);
  return {
    from: options.from, to: options.to, totals, daily,
    pages: [...pages.values()].sort((a, b) => b.views - a.views || b.entries - a.entries || a.path.localeCompare(b.path)).slice(0, LIST),
    sources: {
      groups: [...groups].map(([group, visitors]) => ({ group, label: SOURCE_GROUPS[group], visitors }))
        .sort(byCount((item) => item.visitors, (item) => item.label)),
      hosts: hosts.sort(byCount((item) => item.visitors, (item) => item.source)).slice(0, LIST),
    },
    crawlers: [...crawlers].map(([name, paths]) => ({ name, fetches: [...paths.values()].reduce((a, b) => a + b, 0),
      pages: [...paths].map(([path, fetches]) => ({ path, fetches })).sort(byCount((item) => item.fetches, (item) => item.path)).slice(0, 10) }))
      .sort(byCount((item) => item.fetches, (item) => item.name)),
    funnel: [
      { step: 'visitors', count: totals.visitors }, { step: 'signups', count: totals.signups }, { step: 'accounts', count: totals.accounts },
      { step: 'firstTasks', count: sum('firstTasks') }, { step: 'firstConfirmed', count: sum('firstConfirmed') },
    ],
  };
}
