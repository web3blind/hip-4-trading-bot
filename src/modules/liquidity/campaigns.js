// Public finalized payout periods are historical evidence, NOT active campaigns.
// No wallet, signing, or account-eligibility requests are made here.
const PERIODS_URL = 'https://pd-liquidity-rewards-payouts.outcome-e91.workers.dev/v1/rewards/periods';
const SOURCE_DOC = 'https://docs.outcome.xyz/sdk/reference/outcome-rewards.md';
const ACTIVE_REASON = 'No public current campaign/eligibility API verified; builder attribution, main-wallet approval and frontend whitelist are unverified.';
const integer = (v, max = 1_000_000_000) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const decimal = v => typeof v === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(v) && v.length <= 32;
const iso = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const date = v => typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const plain = v => typeof v === 'string' && v.length > 0 && v.length <= 300 && !/[\x00-\x1f<>]/.test(v);

function parsePeriod(p) {
  if (!p || typeof p !== 'object' || typeof p.market_id !== 'string' || !/^[OQ]\d{1,16}$/.test(p.market_id) ||
    !plain(p.market_name) || !['market', 'epoch'].includes(p.period_type) ||
    !(p.epoch_end_date === null || date(p.epoch_end_date)) ||
    (p.period_type === 'epoch' && !date(p.epoch_end_date)) ||
    !iso(p.finalized_at) || !decimal(p.awarded_usdc) || !decimal(p.paid_usdc) ||
    !integer(p.wallets) || !integer(p.payments) || !['unpaid', 'partial', 'paid'].includes(p.state))
    throw new Error('Invalid reward period');
  return { marketId: p.market_id, epochEndDate: p.epoch_end_date, marketName: p.market_name,
    periodType: p.period_type, finalizedAt: p.finalized_at, awardedUsdc: p.awarded_usdc,
    paidUsdc: p.paid_usdc, wallets: p.wallets, payments: p.payments, state: p.state };
}
function parsePage(data, limit, offset) {
  const p = data?.page;
  if (!p || !Array.isArray(data.periods) || data.periods.length > limit ||
    p.limit !== limit || p.offset !== offset || p.returned !== data.periods.length ||
    !integer(p.total) || p.total < offset + p.returned || typeof p.has_more !== 'boolean' ||
    p.has_more !== (offset + p.returned < p.total)) throw new Error('Invalid reward page');
  const periods = data.periods.map(parsePeriod);
  const ids = periods.map(x => `${x.marketId}:${x.periodType}:${x.epochEndDate ?? 'market'}`);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate reward period');
  return { periods, page: { limit, offset, returned: p.returned, total: p.total, hasMore: p.has_more } };
}
async function boundedJson(response, maxBodyBytes) {
  if (!response.ok || !/^application\/json\b/i.test(response.headers.get('content-type') || '')) throw new Error('Reward HTTP response unavailable');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBodyBytes) throw new Error('Reward response too large');
  if (!response.body?.getReader) throw new Error('Reward response has no stream');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) throw new Error('Reward response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let pos = 0;
  for (const chunk of chunks) { bytes.set(chunk, pos); pos += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Independent, in-memory monitor; never persists wallet data or extrapolates campaigns. */
export function createCampaignMonitor({ fetch: request = globalThis.fetch, now = Date.now,
  ttlMs = 60_000, timeoutMs = 5_000, maxBodyBytes = 256_000 } = {}) {
  if (typeof request !== 'function' || typeof now !== 'function' || !integer(ttlMs, 3_600_000) ||
      !integer(timeoutMs, 30_000) || timeoutMs === 0 || !integer(maxBodyBytes, 1_000_000) || maxBodyBytes === 0)
    throw new Error('Invalid reward monitor options');
  const cache = new Map();
  const previous = new Map();
  const inflight = new Map();
  async function getCampaignSnapshot({ limit = 50, offset = 0 } = {}) {
    if (!integer(limit, 500) || limit < 1 || !integer(offset, 5_000)) throw new Error('Invalid reward limit or offset');
    const active = { available: false, campaigns: [], eligibility: 'unknown', reason: ACTIVE_REASON };
    const key = `${limit}:${offset}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at >= 0 && now() - cached.at < ttlMs)
      return { available: false, active, history: { ...cached.history, changes: [] } };
    if (inflight.has(key)) return inflight.get(key);
    const pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url = `${PERIODS_URL}?limit=${limit}&offset=${offset}`;
        const response = await request(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        const parsed = parsePage(await boundedJson(response, maxBodyBytes), limit, offset);
        const seen = previous.get(key);
        const current = new Map();
        const changes = [];
        for (const period of parsed.periods) {
          const id = `${period.marketId}:${period.periodType}:${period.epochEndDate ?? 'market'}`;
          const serialized = JSON.stringify(period);
          current.set(id, serialized);
          if (seen && seen.get(id) !== serialized) changes.push({ type: seen.has(id) ? 'updated' : 'new', period });
        }
        previous.set(key, current);
        const history = { available: true, source: PERIODS_URL, documentation: SOURCE_DOC,
          fetchedAt: new Date(now()).toISOString(), page: parsed.page,
          complete: !parsed.page.hasMore && offset === 0, periods: parsed.periods, changes };
        cache.set(key, { at: now(), history });
        return { available: false, active, history };
      } catch {
        cache.delete(key);
        return { available: false, active, history: { available: false, source: PERIODS_URL,
          documentation: SOURCE_DOC, error: 'reward_history_unavailable', periods: [], changes: [], complete: false } };
      } finally { clearTimeout(timer); }
    })();
    inflight.set(key, pending);
    try { return await pending; } finally { inflight.delete(key); }
  }
  return { getCampaignSnapshot };
}
const defaultMonitor = createCampaignMonitor();
export function getCampaignSnapshot(options = {}) {
  // Injected transport/clock is deliberately isolated from production cache.
  const { fetch, now, ttlMs, timeoutMs, maxBodyBytes, ...pagination } = options;
  if (fetch || now || ttlMs !== undefined || timeoutMs !== undefined || maxBodyBytes !== undefined)
    return createCampaignMonitor({ fetch, now, ttlMs, timeoutMs, maxBodyBytes }).getCampaignSnapshot(pagination);
  return defaultMonitor.getCampaignSnapshot(pagination);
}
