import type { Logger } from './db.js';

/**
 * SODA v2.1 client for data.transportation.gov (Part B §1).
 *
 * Never point this at ai.fmcsa.dot.gov or li-public.fmcsa.dot.gov -- their WAF blocks
 * datacenter/proxy IPs (observed by other production pipelines per Part B §1, and
 * independently re-confirmed during Task 2's column-verification research this session:
 * every fetch attempt against fmcsa.dot.gov subdomains returned HTTP 403). Everything this
 * pipeline needs lives on the Socrata portal (data.transportation.gov), which serves
 * server/datacenter IPs fine.
 */

/** Known dataset IDs (Part B §1). Centralized here so sources/*.ts never hardcode a magic
 *  string. `LI_AUTH_HISTORY` is Phase-2 (not ingested v1, per Part B §1.2) -- listed for
 *  discoverability only. */
export const SOCRATA_DATASETS = {
  /** Company Census File -- primary daily source (Part B §1.1). */
  COMPANY_CENSUS: 'az4n-8mr2',
  /** Carrier -- All With History: operating-authority + BIPD/cargo/bond required-vs-on-file
   *  (Part B §1.2). Exact column names UNVERIFIED -- see ../COLUMN-VERIFICATION.md. */
  LI_CARRIER_ALL_WITH_HISTORY: '6eyk-hxee',
  /** ActPendInsur -- All With History: active/pending insurance policies, coverage amounts,
   *  effective + cancel-effective dates (Part B §1.2). */
  LI_ACT_PEND_INSUR: 'qh9u-swkp',
  /** AuthHist -- All With History: authority grant/revocation timeline. Phase-2 nice-to-
   *  have, NOT ingested v1 (Part B §1.2) -- do not wire this into sources/authority.ts. */
  LI_AUTH_HISTORY: '9mw4-x3tu',
  /** SMS AB PassProperty -- primary monthly safety source (Part B §1.3). */
  SMS_AB_PASSPROPERTY: '4y6x-dmck',
  /** CSMS/SMS Raw Data -- fallback if 4y6x-dmck isn't row-queryable by dot_number the way
   *  Part B expects (⚠️R3, Part B §7). */
  SMS_RAW_FALLBACK: 'sjpe-nzai',
} as const;

export type SocrataDatasetId = (typeof SOCRATA_DATASETS)[keyof typeof SOCRATA_DATASETS];

export interface SocrataQueryParams {
  $select?: string;
  $where?: string;
  $order?: string;
  $limit?: number;
  $offset?: number;
  $q?: string;
  /** Any other SoQL param (e.g. a specific `$group`) or a named-column equality filter. */
  [key: string]: string | number | undefined;
}

export class SocrataHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = 'SocrataHttpError';
  }
}

export interface SocrataClientOptions {
  appToken: string;
  /** Default 'https://data.transportation.gov' -- override only for a local fixture server
   *  in tests. */
  baseUrl?: string;
  /** Socrata's documented ceiling with a token: 1,000 requests per rolling hour
   *  (dev.socrata.com/docs/app-tokens.html). */
  requestsPerHour?: number;
  fetchImpl?: typeof fetch;
  log?: Logger;
}

const DEFAULT_BASE_URL = 'https://data.transportation.gov';
const DEFAULT_REQUESTS_PER_HOUR = 1_000;
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt: number): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  const jitter = Math.random() * 0.25 * exp; // avoid a thundering herd against one shared token
  return Math.min(MAX_DELAY_MS, Math.round(exp + jitter));
}

/**
 * Sliding-window limiter enforcing the 1,000/rolling-hour budget (Part B §1, §2.5).
 * O(window size) per acquire, which is fine here: a full census backfill is ~9 requests,
 * even a from-scratch multi-source backfill run is low hundreds -- nowhere near needing a
 * fancier token-bucket implementation.
 */
class HourlyRateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    const windowMs = 60 * 60 * 1000;
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => t > now - windowMs);
      if (this.timestamps.length < this.limit) {
        this.timestamps.push(now);
        return;
      }
      const oldest = this.timestamps[0] as number;
      const waitMs = oldest + windowMs - now + 50;
      await sleep(Math.max(waitMs, 0));
    }
  }
}

function buildQueryString(params: SocrataQueryParams): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    usp.set(key, String(value));
  }
  return usp.toString();
}

export class SocrataClient {
  private readonly appToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger | undefined;
  private readonly limiter: HourlyRateLimiter;

  constructor(options: SocrataClientOptions) {
    this.appToken = options.appToken;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log;
    this.limiter = new HourlyRateLimiter(options.requestsPerHour ?? DEFAULT_REQUESTS_PER_HOUR);
  }

  /** One raw page fetch with rate-limiting + retry/backoff on 429/5xx/network errors. */
  async fetchPage<T = Record<string, unknown>>(
    dataset: string,
    params: SocrataQueryParams = {}
  ): Promise<T[]> {
    const url = new URL(`/resource/${dataset}.json`, this.baseUrl);
    url.search = buildQueryString(params);

    let attempt = 0;
    for (;;) {
      attempt += 1;
      await this.limiter.acquire();

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { 'X-App-Token': this.appToken, Accept: 'application/json' },
        });
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(
            `Socrata request to ${dataset} failed after ${attempt} attempts (network error): ${String(err)}`
          );
        }
        this.log?.warn('socrata.network_retry', { dataset, attempt, err: String(err) });
        await sleep(backoffDelayMs(attempt));
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) {
          const body = await res.text().catch(() => '');
          throw new SocrataHttpError(
            `Socrata ${dataset} returned ${res.status} after ${attempt} attempts`,
            res.status,
            body
          );
        }
        const retryAfter = res.headers.get('retry-after');
        const delay = retryAfter ? Number(retryAfter) * 1000 : NaN;
        this.log?.warn('socrata.throttle_retry', { dataset, attempt, status: res.status });
        await sleep(Number.isFinite(delay) && delay > 0 ? delay : backoffDelayMs(attempt));
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new SocrataHttpError(`Socrata ${dataset} returned ${res.status}: ${res.statusText}`, res.status, body);
      }

      return (await res.json()) as T[];
    }
  }

  /** `$select=count(1)` helper -- the R1 volume probes (Part B §7) and dq-report sizing
   *  checks both want this. */
  async count(dataset: string, where?: string): Promise<number> {
    const rows = await this.fetchPage<{ count?: string }>(dataset, {
      $select: 'count(1) as count',
      $where: where,
    });
    const raw = rows[0]?.count;
    const n = raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(`Unexpected count(1) response shape from ${dataset}: ${JSON.stringify(rows)}`);
    }
    return n;
  }

  /**
   * Generic `$limit`/`$offset` paging. Fine for the smaller L&I/safety pulls (tens of pages,
   * Part B §2.4). NOT recommended at census-table depth -- Socrata's own guidance and Part
   * B §2.1 both call out that offset paging degrades at depth; use `paginateKeyset` there.
   */
  async *paginateOffset<T = Record<string, unknown>>(
    dataset: string,
    params: SocrataQueryParams = {},
    pageSize = 50_000
  ): AsyncGenerator<T[], void, unknown> {
    let offset = params.$offset ?? 0;
    for (;;) {
      const page = await this.fetchPage<T>(dataset, { ...params, $limit: pageSize, $offset: offset });
      if (page.length === 0) return;
      yield page;
      if (page.length < pageSize) return;
      offset += pageSize;
    }
  }

  /**
   * Keyset paging on an ascending numeric column -- census's `dot_number > last_key`
   * (Part B §2.1/§1.1: "stable and fast at depth", unlike $offset). `opts.keyColumn` must be
   * present in every row (i.e. included in `$select` if one is given).
   */
  async *paginateKeyset<T extends Record<string, unknown>>(
    dataset: string,
    params: SocrataQueryParams,
    opts: { keyColumn: string; pageSize?: number; startAfter?: number }
  ): AsyncGenerator<T[], void, unknown> {
    const pageSize = opts.pageSize ?? 50_000;
    let lastKey = opts.startAfter ?? -1;

    for (;;) {
      const keysetWhere = `${opts.keyColumn} > ${lastKey}`;
      const where = params.$where ? `(${params.$where}) AND ${keysetWhere}` : keysetWhere;
      const page = await this.fetchPage<T>(dataset, {
        ...params,
        $where: where,
        $order: opts.keyColumn,
        $limit: pageSize,
      });
      if (page.length === 0) return;
      yield page;
      if (page.length < pageSize) return;

      const lastRow = page[page.length - 1] as T;
      const nextKey = Number(lastRow[opts.keyColumn]);
      if (!Number.isFinite(nextKey)) {
        throw new Error(
          `paginateKeyset: could not read a numeric "${opts.keyColumn}" from the last row of ${dataset}`
        );
      }
      lastKey = nextKey;
    }
  }
}
