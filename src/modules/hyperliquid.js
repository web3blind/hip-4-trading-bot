/**
 * HyperLiquid API Client for HIP-4 Outcome Trading
 *
 * Info endpoints via raw fetch.
 * Exchange endpoints (order, cancel) use EIP-712 typed-data signing
 * with msgpack action hashing — compatible with ethers v5.
 */

import { ethers } from 'ethers';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { HL_API, DEFAULTS } from './constants.js';
import { isOutcomeCoin, normalizeOutcomeCoin, coinToOutcome } from './hl-encoding.js';

const signerNonces = new Map();
// Reserve one percent of notional for fees. Never use the reserve as price
// slippage; order caps are immutable. Higher published fee rates fail closed.
export const FEE_RESERVE = 0.01;
function quantize(value, decimals, up = false) {
  const text = Number(value).toFixed(12);
  const [whole, fraction] = text.split('.');
  const scale = 10n ** BigInt(decimals);
  let units = BigInt(whole) * scale + BigInt((fraction.slice(0, decimals) || '0'));
  if (up && /[1-9]/.test(fraction.slice(decimals))) units++;
  return Number(units) / Number(scale);
}
export class UnknownExecutionError extends Error {
  constructor(message = 'Execution unknown. Check orders, fills and ledger before any retry.') {
    super(message); this.name = 'UnknownExecutionError'; this.executionUnknown = true;
  }
}
function positive(value, label) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !/^(?:[0-9]+)(?:\.[0-9]+)?$/.test(value))) throw new Error(`Invalid ${label}`);
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) throw new Error(`Invalid ${label}`);
  return n;
}
function assertExchange(result) {
  if (result?.status === 'err') throw new Error(typeof result.response === 'string' ? result.response : 'Exchange rejected action');
  if (result?.status !== 'ok') throw new UnknownExecutionError();
  return result;
}
export function orderStatuses(result, count) {
  assertExchange(result);
  const statuses = result?.response?.data?.statuses;
  if (result?.response?.type !== 'order' || !Array.isArray(statuses) || statuses.length !== count) {
    const e = new UnknownExecutionError('Incomplete order response. Check all orders and fills before retrying.'); e.hlResult = result; throw e;
  }
  for (const s of statuses) {
    if (!s || typeof s !== 'object' || Object.keys(s).length !== 1) throw new UnknownExecutionError();
    if (typeof s.error === 'string' && s.error) continue;
    if (!Object.hasOwn(s, 'filled') && !Object.hasOwn(s, 'resting')) throw new UnknownExecutionError();
    const v = s.filled || s.resting;
    if (!v || !Number.isSafeInteger(v.oid) || v.oid <= 0) throw new UnknownExecutionError();
    if (s.filled && !(Number.isFinite(Number(v.totalSz)) && Number(v.totalSz) > 0 && Number.isFinite(Number(v.avgPx)) && Number(v.avgPx) > 0 && Number(v.avgPx) < 1)) throw new UnknownExecutionError();
  }
  return statuses;
}

const USER_SIGNED_DOMAIN_BY_NETWORK = {
  testnet: {
    name: 'HyperliquidSignTransaction',
    version: '1',
    chainId: 421614,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  },
  mainnet: {
    name: 'HyperliquidSignTransaction',
    version: '1',
    chainId: 42161,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  },
};

// ─── EIP-712 signing helpers (ethers v5) ────────────────────────

const PHANTOM_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};

const AGENT_TYPES = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
};

/**
 * Remove trailing zeros from numeric string.
 * "12345.0" => "12345", "0.12340" => "0.1234"
 */
function removeTrailingZeros(val) {
  if (typeof val !== 'string' || !val.includes('.')) return val;
  const normalized = val.replace(/\.?0+$/, '');
  return normalized === '-0' ? '0' : normalized;
}

/**
 * float -> wire string (max 8 decimals, no trailing zeros)
 */
function floatToWire(x) {
  const rounded = x.toFixed(8);
  let normalized = rounded.replace(/\.?0+$/, '');
  if (normalized === '-0') normalized = '0';
  return normalized;
}

/**
 * HyperLiquid enforces a maximum of 5 significant decimal places
 * for spot/outcome prices. Prices with more decimals get
 * "Price must be divisible by tick size" errors.
 *
 * We round (floor for buys, ceil for sells is caller's concern)
 * to 5 decimal places max.
 */
function formatPriceForHl(price) {
  const numeric = Number(price);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Invalid price: ${price}`);
  }

  if (numeric >= 1) {
    return floatToWire(numeric);
  }

  // For sub-$1 prices (outcome tokens etc.), cap at 5 decimal places
  return removeTrailingZeros(numeric.toFixed(5));
}

function parseOrderStatuses(result) {
  const statuses = result?.response?.data?.statuses;
  return Array.isArray(statuses) ? statuses : [];
}

function getFirstOrderError(result) {
  const statuses = parseOrderStatuses(result);
  const entry = statuses.find((status) => status && typeof status === 'object' && typeof status.error === 'string');
  return entry?.error || null;
}

function normalizeOpenOrderCoin(coin) {
  if (typeof coin !== 'string') return coin;
  return normalizeOutcomeCoin(coin);
}

/**
 * Recursively remove trailing zeros from `p` and `s` fields.
 */
function normalizeAction(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(normalizeAction);

  const result = { ...obj };
  for (const key of Object.keys(result)) {
    const v = result[key];
    if (v && typeof v === 'object') {
      result[key] = normalizeAction(v);
    } else if ((key === 'p' || key === 's') && typeof v === 'string') {
      result[key] = removeTrailingZeros(v);
    }
  }
  return result;
}

/**
 * Compute keccak256( msgpack(action) || nonce_be64 || vaultFlag [|| vaultAddr] )
 */
function actionHash(action, vaultAddress, nonce) {
  const normalized = normalizeAction(action);
  const msgPackBytes = msgpackEncode(normalized);
  const extra = vaultAddress ? 29 : 9;
  const data = new Uint8Array(msgPackBytes.length + extra);
  data.set(msgPackBytes);
  const view = new DataView(data.buffer);
  view.setBigUint64(msgPackBytes.length, BigInt(nonce), false);
  if (!vaultAddress) {
    view.setUint8(msgPackBytes.length + 8, 0);
  } else {
    view.setUint8(msgPackBytes.length + 8, 1);
    data.set(ethers.utils.arrayify(vaultAddress), msgPackBytes.length + 9);
  }
  return ethers.utils.keccak256(data);
}

/**
 * Sign an L1 action via EIP-712 phantom agent.
 */
async function signL1Action(wallet, action, vaultAddress, nonce, isMainnet) {
  const hash = actionHash(action, vaultAddress, nonce);
  const phantomAgent = {
    source: isMainnet ? 'a' : 'b',
    connectionId: hash,
  };

  // ethers v5: wallet._signTypedData(domain, types, value)
  const rawSig = await wallet._signTypedData(
    PHANTOM_DOMAIN,
    AGENT_TYPES,
    phantomAgent,
  );
  const { r, s, v } = ethers.utils.splitSignature(rawSig);
  return { r, s, v };
}

async function signUserSignedAction(wallet, action, payloadTypes, primaryType, isMainnet) {
  const domain = isMainnet
    ? USER_SIGNED_DOMAIN_BY_NETWORK.mainnet
    : USER_SIGNED_DOMAIN_BY_NETWORK.testnet;
  const rawSig = await wallet._signTypedData(
    domain,
    { [primaryType]: payloadTypes },
    action,
  );
  const { r, s, v } = ethers.utils.splitSignature(rawSig);
  return { r, s, v };
}

// ─── Order wire helpers ─────────────────────────────────────────

function orderToWire(order, assetIndex) {
  const wire = {
    a: assetIndex,
    b: order.is_buy,
    p: typeof order.limit_px === 'string'
      ? removeTrailingZeros(order.limit_px)
      : floatToWire(Number(order.limit_px)),
    s: typeof order.sz === 'string'
      ? removeTrailingZeros(order.sz)
      : floatToWire(Number(order.sz)),
    r: order.reduce_only ?? false,
    t: order.order_type,
  };
  if (order.cloid) wire.c = order.cloid;
  return wire;
}

// ─── HLClient ───────────────────────────────────────────────────

export class HLClient {
  /**
   * @param {string} privateKey - Hex private key (with or without 0x prefix)
   * @param {string} network - 'testnet' or 'mainnet'
   */
  constructor(privateKey, network = 'testnet', options = {}) {
    if (!['testnet', 'mainnet'].includes(network)) throw new Error('Invalid network');
    this.authMode = options.authMode || 'wallet';
    if (!['agent', 'wallet'].includes(this.authMode)) throw new Error('Invalid auth mode');
    if (this.authMode === 'agent' && !options.accountAddress) throw new Error('Agent requires owner accountAddress');
    this.requestTimeoutMs = 15000;
    const builder = typeof options.builder === 'string' ? options.builder : options.builder?.b;
    if (options.builder && (!builder || !ethers.utils.isAddress(builder) || (options.builder.f != null && options.builder.f !== 0))) throw new Error('Builder requires address and zero fee');
    this.builder = builder ? { b: builder.toLowerCase(), f: 0 } : null;
    this.network = network;
    this.isMainnet = network === 'mainnet';

    if (privateKey) {
      const key = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
      this.wallet = new ethers.Wallet(key);
      this.address = this.wallet.address;
    } else {
      this.wallet = null;
      this.address = null;
    }

    if (options.accountAddress) {
      this.address = ethers.utils.getAddress(options.accountAddress);
      if (this.authMode === 'wallet' && this.wallet && this.address !== this.wallet.address) throw new Error('Wallet owner/signer mismatch');
    }

    // Caches
    this._spotUniverseCache = null;
    this._spotUniverseCacheTs = 0;
  }

  // ─── Internal helpers ───────────────────────────────────────────

  _infoUrl() {
    return this.isMainnet ? HL_API.MAINNET_INFO : HL_API.TESTNET_INFO;
  }

  _exchangeUrl() {
    return this.isMainnet ? HL_API.MAINNET_EXCHANGE : HL_API.TESTNET_EXCHANGE;
  }

  async _request(url, body, write = false) {
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(write ? new UnknownExecutionError() : new Error('Info request timed out'));
      }, this.requestTimeoutMs); });
      const request = (async () => {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
        if (!response.ok) throw write ? new UnknownExecutionError() : new Error(`HL API HTTP ${response.status}`);
        return await response.json();
      })();
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (write && !error.executionUnknown) throw new UnknownExecutionError();
      throw error;
    } finally { clearTimeout(timer); }
  }

  async _infoRequest(body) { return this._request(this._infoUrl(), body); }

  async _exchangeRequest(payload) {
    return assertExchange(await this._request(this._exchangeUrl(), payload, true));
  }

  /**
   * Generate a unique monotonic nonce (millisecond timestamp).
   */
  _nonce() {
    const key = `${this.network}:${this.wallet?.address.toLowerCase()}`;
    const nonce = Math.max(Date.now(), (signerNonces.get(key) || 0) + 1);
    signerNonces.set(key, nonce);
    return nonce;
  }

  /**
   * Look up the spot universe index for a coin like "#21460".
   * Returns 10000 + universeIndex for the OrderWire `a` field.
   */
  async _resolveSpotAssetIndex(coin) {
    if (!isOutcomeCoin(coin)) throw new Error('Only canonical HIP-4 #/+ outcomes are supported; @ is ordinary spot');
    return 100_000_000 + Number(coin.slice(1));
  }

  /**
   * Get szDecimals for an outcome coin (how many decimal places allowed for size).
   */
  async _getSzDecimals(coin) {
    await this._resolveSpotAssetIndex(coin);
    // Exact outcome metadata only. Absent explicit precision: whole shares and
    // five price decimals are the conservative fallback, never an @ spot pair.
    const spec = await this.getOutcomeSpec(coin);
    const value = spec.sideSpecs?.[coinToOutcome(coin).side]?.szDecimals ?? spec.szDecimals;
    if (value == null) return 0;
    if (!Number.isInteger(value) || value < 0 || value > 8) throw new Error('Invalid outcome precision');
    return value;
  }

  async getOutcomeSpec(coin) {
    const { outcomeId } = coinToOutcome(coin);
    const meta = await this.getOutcomeMeta();
    const spec = meta?.outcomes?.find(s => s.outcome === outcomeId);
    if (!spec) throw new Error('Outcome metadata unavailable');
    if (spec.quoteToken !== 'USDC') throw new Error('Outcome quoteToken must explicitly be USDC');
    return spec;
  }

  /**
   * Round size to the correct number of decimals for this coin.
   */
  async _roundSize(coin, size) {
    const szDecimals = await this._getSzDecimals(coin);
    const factor = Math.pow(10, szDecimals);
    return quantize(positive(size, 'size'), szDecimals);
  }

  // ─── Balance & Funding helpers ──────────────────────────────────

  /**
   * Get perp/USD-class withdrawable balance.
   * @returns {Promise<number>} withdrawable USDC in perp account
   */
  async getPerpBalance() {
    if (!this.address) return 0;
    const state = await this._infoRequest({ type: 'clearinghouseState', user: this.address });
    const value = Number(state?.withdrawable);
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid withdrawable balance');
    return value;
  }

  async getSpotUsdcBalance() {
    if (!this.address) return 0;
    const data = await this.getUserBalances();
    if (!Array.isArray(data?.balances)) throw new Error('Invalid spot balances');
    const usdc = data.balances.find(b => b.coin === 'USDC' && (b.token == null || b.token === 0));
    if (!usdc) return 0;
    const total = Number(usdc.total), hold = Number(usdc.hold);
    if (!Number.isFinite(total) || !Number.isFinite(hold) || total < 0 || hold < 0) throw new Error('Invalid USDC balance/hold');
    return Math.max(0, total - hold);
  }

  async getAccountAbstraction() {
    const mode = await this._infoRequest({ type: 'userAbstraction', user: this.address });
    if (!['disabled', 'default', 'dexAbstraction', 'unifiedAccount', 'portfolioMargin'].includes(mode)) throw new Error('Unknown account abstraction');
    return mode;
  }

  async getAvailableUsdc() {
    const mode = await this.getAccountAbstraction();
    // No synthetic credit/double-counting across mirrored unified ledgers.
    if (['unifiedAccount', 'portfolioMargin'].includes(mode)) return Math.min(await this.getSpotUsdcBalance(), await this.getPerpBalance());
    const spot = await this.getSpotUsdcBalance();
    return this.authMode === 'agent' ? spot : spot + await this.getPerpBalance();
  }

  _requireOwner() {
    if (!this.wallet) throw new Error('No wallet configured for signing');
    if (this.authMode === 'agent' || this.address !== this.wallet.address) throw new Error('Owner action required: use the official Hyperliquid app to transfer or withdraw. Agent cannot sign this action.');
  }

  async ensureOutcomeFunding(requiredUsdc, coin) {
    const required = positive(requiredUsdc, 'funding amount');
    if (coin) await this.getOutcomeSpec(coin);
    const mode = await this.getAccountAbstraction();
    if (['unifiedAccount', 'portfolioMargin'].includes(mode)) return await this.getAvailableUsdc() >= required;
    const spot = await this.getSpotUsdcBalance();
    if (spot >= required) return true;
    this._requireOwner();
    const deficit = Math.ceil((required - spot) * 1e6) / 1e6;
    if (await this.getPerpBalance() < deficit) return false;
    await this.transferUsdClass(deficit, false);
    return await this.getSpotUsdcBalance() >= required;
  }

  async ensureWithdrawalFunding(amount) {
    this._requireOwner();
    amount = positive(amount, 'withdraw amount');
    const mode = await this.getAccountAbstraction();
    const perp = await this.getPerpBalance();
    if (perp >= amount) return true;
    if (['unifiedAccount', 'portfolioMargin'].includes(mode)) return false;
    const deficit = Math.ceil((amount - perp) * 1e6) / 1e6;
    if (await this.getSpotUsdcBalance() < deficit) return false;
    await this.transferUsdClass(deficit, true);
    return await this.getPerpBalance() >= amount;
  }


  // ─── Info endpoints ─────────────────────────────────────────────

  async getOutcomeMeta() {
    return this._infoRequest({ type: 'outcomeMeta' });
  }

  async getOrderbook(coin) {
    return this._infoRequest({ type: 'l2Book', coin });
  }

  async getAllMids() {
    return this._infoRequest({ type: 'allMids' });
  }

  async getUserBalances(address) {
    const addr = address || this.address;
    if (!addr) throw new Error('No address provided and no wallet configured');
    return this._infoRequest({ type: 'spotClearinghouseState', user: addr });
  }

  async getUserFills(address) {
    const addr = address || this.address;
    if (!addr) throw new Error('No address provided and no wallet configured');
    return this._infoRequest({ type: 'userFills', user: addr });
  }

  async getOpenOrders(address) {
    const addr = address || this.address;
    if (!addr) throw new Error('No address provided and no wallet configured');
    const orders = await this._infoRequest({ type: 'openOrders', user: addr });
    return Array.isArray(orders)
      ? orders.map((order) => ({ ...order, coin: normalizeOpenOrderCoin(order.coin) }))
      : orders;
  }

  async getOrderStatus(oid, address = this.address) {
    if (!address || !Number.isSafeInteger(Number(oid)) || Number(oid) <= 0) throw new Error('Invalid order lookup');
    return this._infoRequest({ type: 'orderStatus', user: address, oid: Number(oid) });
  }

  async getCandles(coin, interval, startTime, endTime) {
    return this._infoRequest({
      type: 'candleSnapshot',
      req: { coin, interval, startTime, endTime },
    });
  }

  // ─── Exchange endpoints ─────────────────────────────────────────

  _orderTypeToWire(orderType) {
    if (orderType === 'Market') {
      return { limit: { tif: 'Ioc' } };
    }
    return { limit: { tif: 'Gtc' } };
  }

  async _buildOrderWire({ coin, isBuy, price, size, orderType = 'Limit', maxSpend }) {
    price = positive(price, 'price'); size = positive(size, 'size');
    if (price >= 1 || typeof isBuy !== 'boolean' || !['Limit', 'Market'].includes(orderType)) throw new Error('Invalid outcome order');
    coin = normalizeOutcomeCoin(coin);
    const roundedSize = await this._roundSize(coin, size);
    if (roundedSize <= 0) throw new Error('Order size too small after rounding');

    const assetIndex = await this._resolveSpotAssetIndex(coin);
    const decimals = Math.min(5, 8 - await this._getSzDecimals(coin));
    const factor = 10 ** decimals;
    const roundedPrice = quantize(price, decimals, !isBuy);
    if (roundedPrice <= 0 || roundedPrice >= 1) throw new Error('Price outside outcome tick range');
    const formattedPrice = removeTrailingZeros(roundedPrice.toFixed(decimals));
    if (maxSpend != null && isBuy && roundedPrice * roundedSize * (1 + FEE_RESERVE) > positive(maxSpend, 'budget')) throw new Error('Reviewed budget exceeded');


    return orderToWire({
      is_buy: isBuy,
      limit_px: formattedPrice,
      sz: roundedSize,
      order_type: this._orderTypeToWire(orderType),
      reduce_only: false,
    }, assetIndex);
  }

  async prepareOrder({ coin, isBuy, price, size, budget, orderType = 'Limit' }) {
    if (isBuy && budget != null) {
      budget = positive(budget, 'budget');
      size = budget / (positive(price, 'price') * (1 + FEE_RESERVE));
    }
    const wire = await this._buildOrderWire({ coin, isBuy, price, size, orderType });
    const notional = Number(wire.p) * Number(wire.s);
    if (notional < 10) throw new Error('Minimum $10 notional after rounding');
    const maxSpend = isBuy ? quantize(notional * (1 + FEE_RESERVE), 6, true) : null;
    if (budget != null && maxSpend > budget) throw new Error('Reviewed budget exceeded after rounding');
    return { coin: normalizeOutcomeCoin(coin), isBuy, price: Number(wire.p), size: Number(wire.s), orderType, maxSpend };
  }

  async prepareMarketOrder(coin, isBuy, amount, slippagePct = DEFAULTS.ORDER_SLIPPAGE_PERCENT) {
    if (!Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct > 100) throw new Error('Invalid slippage');
    const book = await this.getOrderbook(coin);
    const ref = positive(book?.levels?.[isBuy ? 1 : 0]?.[0]?.px, 'book price');
    if (ref >= 1) throw new Error('Invalid book price');
    const price = isBuy ? Math.min(ref * (1 + slippagePct / 100), 0.99999) : Math.max(ref * (1 - slippagePct / 100), 0.00001);
    return this.prepareOrder({ coin, isBuy, price, ...(isBuy ? { budget: amount } : { size: amount }), orderType: 'Market' });
  }

  async _checkFeeReserve() {
    const fees = await this._infoRequest({ type: 'userFees', user: this.address });
    const rate = Number(fees?.userSpotCrossRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > FEE_RESERVE) throw new Error('Cannot verify trading fees within reviewed reserve');
  }

  /**
   * Place multiple orders in one signed HyperLiquid order action.
   *
   * @param {Array<{coin:string,isBuy:boolean,price:number|string,size:number|string,orderType?:string}>} orderRequests
   * @param {object} options
   * @param {string} options.grouping - HyperLiquid grouping mode; defaults to 'na'
   * @param {boolean} options.throwOnError - throw if any status has error; defaults true
   * @returns {Promise<object>} Exchange response
   */
  async placeOrders(orderRequests, { grouping = 'na', throwOnError = true } = {}) {
    if (!this.wallet) throw new Error('No wallet configured for signing');
    if (!Array.isArray(orderRequests) || orderRequests.length === 0) {
      throw new Error('No orders provided');
    }

    if (orderRequests.some(r => r.isBuy && r.maxSpend != null)) await this._checkFeeReserve();
    const orderWires = [];
    for (const request of orderRequests) {
      orderWires.push(await this._buildOrderWire(request));
    }

    const action = {
      type: 'order',
      orders: orderWires,
      grouping,
      ...(this.builder ? { builder: this.builder } : {}),
    };

    const nonce = this._nonce();
    const signature = await signL1Action(
      this.wallet,
      action,
      null, // no vault
      nonce,
      this.isMainnet,
    );

    const payload = {
      action,
      nonce,
      signature,
      vaultAddress: null,
    };


    const result = await this._exchangeRequest(payload);
    const orderErrors = orderStatuses(result, orderWires.length)
      .map((status, index) => ({ index, error: status?.error }))
      .filter(entry => entry.error);
    if (throwOnError && orderErrors.length > 0) {
      const error = new Error(orderErrors.map(entry => entry.error).join('; '));
      error.hlResult = result;
      error.orderErrors = orderErrors;
      throw error;
    }
    return result;
  }

  /**
   * Place an order on the spot orderbook.
   *
   * @param {string} coin - e.g. "#21460"
   * @param {boolean} isBuy - true for buy, false for sell
   * @param {number|string} price - limit price
   * @param {number|string} size - order size (in outcome shares)
   * @param {string} orderType - 'Limit' (GTC) or 'Market' (IOC with slippage)
   * @returns {Promise<object>} Exchange response
   */
  async placeOrder(coin, isBuy, price, size, orderType = 'Limit') {
    return this.placeOrders([{ coin, isBuy, price, size, orderType }]);
  }

  /**
   * Place a market order with slippage protection.
   * Uses IOC order type with aggressive price.
   *
   * @param {string} coin - outcome coin e.g. "#21460"
   * @param {boolean} isBuy - buy or sell
   * @param {number} sizeUsdc - amount in USDC to spend (for buys) — will be converted to shares
   * @param {number} [slippagePct=2] - slippage percentage
   * @returns {Promise<object>}
   */
  async placeMarketOrder(coin, isBuy, size, slippagePct = DEFAULTS.ORDER_SLIPPAGE_PERCENT, options = {}) {
    const reviewed = options.reviewed;
    if (!reviewed || reviewed.coin !== normalizeOutcomeCoin(coin) || reviewed.isBuy !== isBuy || reviewed.size !== size || reviewed.orderType !== 'Market') throw new Error('Market order requires a reviewed price and budget cap');
    try {
      return await this.placeOrders([reviewed]);
    } catch (err) {
      // Only a complete single IOC rejection proves no exposure was accepted.
      // Never retry a timeout, partial response or ambiguous HTTP failure.
      const statuses = err.hlResult ? orderStatuses(err.hlResult, 1) : [];
      const msg = String(statuses[0]?.error || '').toLowerCase();
      if (options.allowRestingFallback === true && !err.executionUnknown && (msg.includes('80%') || msg.includes('reference price') || msg.includes('could not immediately match'))) {
        return this.placeOrders([{ ...reviewed, orderType: 'Limit' }]);
      }
      throw err;
    }
  }


  async transferUsdClass(amount, toPerp) {
    this._requireOwner();
    amount = positive(amount, 'transfer amount');
    if (typeof toPerp !== 'boolean') throw new Error('Invalid transfer direction');

    const nonce = this._nonce();
    const action = {
      type: 'usdClassTransfer',
      hyperliquidChain: this.isMainnet ? 'Mainnet' : 'Testnet',
      signatureChainId: this.isMainnet ? '0xa4b1' : '0x66eee',
      amount: String(amount),
      toPerp: Boolean(toPerp),
      nonce,
    };

    const signature = await signUserSignedAction(
      this.wallet,
      action,
      [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'toPerp', type: 'bool' },
        { name: 'nonce', type: 'uint64' },
      ],
      'HyperliquidTransaction:UsdClassTransfer',
      this.isMainnet,
    );

    const result = assertExchange(await this._exchangeRequest({ action, nonce, signature }));
    if (result?.response?.type !== 'default') throw new UnknownExecutionError();
    return result;
  }

  async transferBetweenSpotAndPerp(amount, toPerp) {
    return this.transferUsdClass(amount, toPerp);
  }

  /**
   * Request a USDC bridge withdrawal from the standard perp ledger to Arbitrum.
   * @param {string} destination - 0x-prefixed destination address
   * @param {number|string} amount - USDC amount to withdraw
   * @returns {Promise<object>} Exchange response
   */
  async withdraw(destination, amount) {
    this._requireOwner();
    amount = positive(amount, 'withdraw amount');
    if (!ethers.utils.isAddress(destination) || destination === ethers.constants.AddressZero) throw new Error('Invalid destination');

    const nonce = this._nonce();
    const action = {
      type: 'withdraw3',
      hyperliquidChain: this.isMainnet ? 'Mainnet' : 'Testnet',
      signatureChainId: this.isMainnet ? '0xa4b1' : '0x66eee',
      amount: String(amount),
      time: nonce,
      destination,
    };

    const signature = await signUserSignedAction(
      this.wallet,
      action,
      [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'destination', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'time', type: 'uint64' },
      ],
      'HyperliquidTransaction:Withdraw',
      this.isMainnet,
    );

    const result = assertExchange(await this._exchangeRequest({ action, nonce, signature }));
    if (result?.response?.type !== 'default') throw new UnknownExecutionError();
    return result;
  }

  /**
   * Cancel an order.
   * @param {string} coin - e.g. "#21460"
   * @param {number} orderId - Order OID
   */
  async cancelOrder(coin, orderId) {
    return this.cancelOrders([{ coin, oid: orderId }]);
  }

  async cancelOrders(orders) {
    if (!this.wallet) throw new Error('No wallet configured for signing');
    if (!Array.isArray(orders) || !orders.length) throw new Error('No reviewed orders');
    const cancels = [];
    for (const order of orders) {
      const oid = Number(order.oid);
      if (!Number.isSafeInteger(oid) || oid <= 0) throw new Error('Invalid order ID');
      cancels.push({ a: await this._resolveSpotAssetIndex(order.coin), o: oid });
    }
    const action = { type: 'cancel', cancels };
    const nonce = this._nonce();
    const signature = await signL1Action(this.wallet, action, null, nonce, this.isMainnet);
    const result = assertExchange(await this._exchangeRequest({ action, nonce, signature, vaultAddress: null }));
    const statuses = result?.response?.data?.statuses;
    if (result?.response?.type !== 'cancel' || !Array.isArray(statuses) || statuses.length !== cancels.length) throw new UnknownExecutionError('Cancellation status incomplete; inspect the exact OIDs before retrying.');
    const failures = statuses.map((s, i) => s === 'success' ? null : { oid: cancels[i].o, error: s?.error || 'Unknown cancel status' }).filter(Boolean);
    const remaining = await this.getOpenOrders();
    if (!Array.isArray(remaining)) throw new UnknownExecutionError('Cancel readback unavailable');
    const open = remaining.filter(o => cancels.some(c => c.o === Number(o.oid)));
    if (failures.length || open.length) {
      const error = new Error(`Cancellation not fully verified. OIDs: ${[...new Set([...failures.map(f => f.oid), ...open.map(o => o.oid)])].join(', ')}`);
      error.cancelErrors = failures; error.hlResult = result; throw error;
    }
    return { ...result, verifiedCancelled: cancels.map(c => c.o) };
  }

  async cancelAllOrders(reviewedOrders) {
    const orders = reviewedOrders || (await this.getOpenOrders()).filter(o => isOutcomeCoin(o.coin));
    if (!orders.length) return { status: 'ok', verifiedCancelled: [] };
    return this.cancelOrders(orders);
  }


  // ─── Factory ────────────────────────────────────────────────────

  static async create(privateKey, network = 'testnet', options = {}) {
    const client = new HLClient(privateKey, network, options);
    return client;
  }

  // ─── Utility ────────────────────────────────────────────────────

  getAddress() {
    return this.address;
  }
}
