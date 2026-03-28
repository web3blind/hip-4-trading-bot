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
  return coin.startsWith('@') ? `#${coin.slice(1)}` : coin;
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
  constructor(privateKey, network = 'testnet') {
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

  async _infoRequest(body) {
    const response = await fetch(this._infoUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HL API error: ${response.status} ${response.statusText}`);
    return response.json();
  }

  async _exchangeRequest(payload) {
    const response = await fetch(this._exchangeUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HL Exchange error ${response.status}: ${text}`);
    }
    return response.json();
  }

  /**
   * Generate a unique monotonic nonce (millisecond timestamp).
   */
  _nonce() {
    const ts = Date.now();
    if (!this._lastNonce || ts > this._lastNonce) {
      this._lastNonce = ts;
    } else {
      this._lastNonce++;
    }
    return this._lastNonce;
  }

  /**
   * Look up the spot universe index for a coin like "#21460".
   * Returns 10000 + universeIndex for the OrderWire `a` field.
   */
  async _resolveSpotAssetIndex(coin) {
    // HIP-4 outcome coins use "#" prefix (e.g. "#90", "#110").
    // Their asset ID = 100_000_000 + encoding (per HL docs "Asset IDs / Outcomes").
    // This is DIFFERENT from regular spot coins (@90) which use 10_000 + universe.index.
    if (coin.startsWith('#')) {
      const encoding = parseInt(coin.slice(1), 10);
      if (!isNaN(encoding)) {
        return 100_000_000 + encoding;
      }
    }

    // Regular spot coins — look up in spotMeta universe
    const TTL = 5 * 60_000;
    const now = Date.now();
    if (!this._spotUniverseCache || now - this._spotUniverseCacheTs > TTL) {
      const meta = await this._infoRequest({ type: 'spotMeta' });
      this._spotUniverseCache = meta;
      this._spotUniverseCacheTs = now;
    }

    const universe = this._spotUniverseCache?.universe || [];
    const lookupName = coin.startsWith('@') ? coin : '@' + coin;

    for (const entry of universe) {
      const entryName = entry.name || '';
      if (entryName === lookupName || entryName === coin || entryName.startsWith(lookupName + '/')) {
        return 10000 + entry.index;
      }
    }

    throw new Error(`Cannot resolve spot asset index for coin "${coin}". Not found in spot universe.`);
  }

  /**
   * Get szDecimals for an outcome coin (how many decimal places allowed for size).
   */
  async _getSzDecimals(coin) {
    // Ensure cache is populated
    await this._resolveSpotAssetIndex(coin);

    const universe = this._spotUniverseCache?.universe || [];
    const tokens = this._spotUniverseCache?.tokens || [];
    const lookupName = coin.startsWith('#') ? '@' + coin.slice(1) : coin;

    for (const entry of universe) {
      const entryName = entry.name || '';
      if (entryName === lookupName || entryName === coin) {
        const tokenIdx = Array.isArray(entry.tokens) ? entry.tokens[0] : null;
        if (tokenIdx != null && tokens[tokenIdx]) {
          return tokens[tokenIdx].szDecimals ?? 0;
        }
        break;
      }
    }

    return 0;
  }

  /**
   * Round size to the correct number of decimals for this coin.
   */
  async _roundSize(coin, size) {
    const szDecimals = await this._getSzDecimals(coin);
    const factor = Math.pow(10, szDecimals);
    return Math.floor(size * factor) / factor;
  }

  // ─── Balance & Funding helpers ──────────────────────────────────

  /**
   * Get perp/USD-class withdrawable balance.
   * @returns {Promise<number>} withdrawable USDC in perp account
   */
  async getPerpBalance() {
    try {
      const addr = this.address;
      if (!addr) return 0;
      const state = await this._infoRequest({ type: 'clearinghouseState', user: addr });
      const withdrawable = parseFloat(state?.withdrawable || '0');
      return Number.isFinite(withdrawable) ? withdrawable : 0;
    } catch (err) {
      process.stderr.write(`[getPerpBalance] error: ${err.message}\n`);
      return 0;
    }
  }

  /**
   * Get spot USDC balance.
   * @returns {Promise<number>} total USDC in spot account
   */
  async getSpotUsdcBalance() {
    try {
      const addr = this.address;
      if (!addr) return 0;
      const data = await this._infoRequest({ type: 'spotClearinghouseState', user: addr });
      const balances = data?.balances || [];
      const usdc = balances.find(b =>
        b.coin === 'USDC' || b.coin === 'USD' || b.coin === 'USDH'
      );
      const total = parseFloat(usdc?.total || usdc?.available || '0');
      return Number.isFinite(total) ? total : 0;
    } catch (err) {
      process.stderr.write(`[getSpotUsdcBalance] error: ${err.message}\n`);
      return 0;
    }
  }

  /**
   * Ensure the perp/USD-class account has enough funding for an outcome trade.
   *
   * Checks perp withdrawable first; if insufficient, transfers from spot USDC.
   * NEVER throws — returns false if funding is impossible.
   *
   * @param {number} requiredUsdc — minimum USDC needed in perp account
   * @returns {Promise<boolean>} true if funded, false if not enough funds
   */
  async ensureOutcomeFunding(requiredUsdc) {
    try {
      if (!requiredUsdc || requiredUsdc <= 0) return true;

      // Round required to 2dp to avoid floating-point dust (e.g. 110.00000000000001)
      const required = Math.ceil(requiredUsdc * 100) / 100;

      const perpBal = await this.getPerpBalance();
      process.stderr.write(`[ensureOutcomeFunding] required=${required}, perpBal=${perpBal}\n`);

      if (perpBal >= required - 0.01) {
        process.stderr.write(`[ensureOutcomeFunding] already funded\n`);
        return true;
      }

      const spotBal = await this.getSpotUsdcBalance();
      process.stderr.write(`[ensureOutcomeFunding] spotBal=${spotBal}\n`);

      const deficit = required - perpBal;

      if (spotBal <= 0) {
        process.stderr.write(`[ensureOutcomeFunding] no spot USDC available, cannot fund\n`);
        return perpBal > 0; // true if perp has *something* (partial), false if zero
      }

      // Transfer what we need (or all available if spot < deficit)
      const transferAmt = Math.min(spotBal, Math.max(deficit, 0));
      if (transferAmt < 0.01) {
        process.stderr.write(`[ensureOutcomeFunding] transfer amount too small: ${transferAmt}\n`);
        // Already close enough — floating point dust
        return perpBal >= required - 0.01;
      }

      // Round to 2 decimal places (USDC precision)
      const roundedAmt = Math.floor(transferAmt * 100) / 100;
      process.stderr.write(`[ensureOutcomeFunding] transferring ${roundedAmt} USDC spot -> perp\n`);

      await this.transferUsdClass(roundedAmt, true);
      process.stderr.write(`[ensureOutcomeFunding] transfer successful\n`);

      // Verify the transfer landed
      const newPerpBal = await this.getPerpBalance();
      process.stderr.write(`[ensureOutcomeFunding] new perpBal=${newPerpBal}\n`);
      return newPerpBal >= required * 0.95; // 5% tolerance for rounding
    } catch (err) {
      process.stderr.write(`[ensureOutcomeFunding] error: ${err.message}\n`);
      return false;
    }
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

  async getCandles(coin, interval, startTime, endTime) {
    return this._infoRequest({
      type: 'candleSnapshot',
      req: { coin, interval, startTime, endTime },
    });
  }

  // ─── Exchange endpoints ─────────────────────────────────────────

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
    if (!this.wallet) throw new Error('No wallet configured for signing');

    // Round size to allowed decimals for this coin
    size = await this._roundSize(coin, Number(size));
    if (size <= 0) throw new Error('Order size too small after rounding');

    const assetIndex = await this._resolveSpotAssetIndex(coin);

    // Debug log for troubleshooting
    process.stderr.write(`[placeOrder] ${JSON.stringify({ coin, isBuy, price, size, orderType, assetIndex })}\n`);

    // Build order_type
    let ot;
    if (orderType === 'Market') {
      ot = { limit: { tif: 'Ioc' } };
    } else {
      ot = { limit: { tif: 'Gtc' } };
    }

    const formattedPrice = formatPriceForHl(price);

    const orderWire = orderToWire({
      is_buy: isBuy,
      limit_px: formattedPrice,
      sz: size,
      order_type: ot,
      reduce_only: false,
    }, assetIndex);

    const action = {
      type: 'order',
      orders: [orderWire],
      grouping: 'na',
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

    process.stderr.write(`[placeOrder] wire: ${JSON.stringify(orderWire)}\n`);

    const result = await this._exchangeRequest(payload);
    const orderError = getFirstOrderError(result);
    if (orderError) {
      const error = new Error(orderError);
      error.hlResult = result;
      throw error;
    }
    process.stderr.write(`[placeOrder] result: ${JSON.stringify(result)}\n`);
    return result;
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
  async placeMarketOrder(coin, isBuy, size, slippagePct = DEFAULTS.ORDER_SLIPPAGE_PERCENT) {
    // Get current price from orderbook
    const book = await this.getOrderbook(coin);
    const [bids, asks] = book?.levels || [[], []];

    let refPrice;
    if (isBuy) {
      refPrice = asks?.[0]?.px ? Number(asks[0].px) : null;
    } else {
      refPrice = bids?.[0]?.px ? Number(bids[0].px) : null;
    }

    if (!refPrice || refPrice <= 0) {
      throw new Error('Cannot determine market price — orderbook is empty');
    }

    // Use IOC (Immediate-Or-Cancel) with generous slippage for true market orders.
    // Price is clamped to [0.00001, 0.99999] for outcome markets.
    const limitPrice = isBuy
      ? Math.min(refPrice * (1 + slippagePct / 100), 0.99999)
      : Math.max(refPrice * (1 - slippagePct / 100), 0.00001);

    const roundedPrice = Number(limitPrice.toFixed(5));

    try {
      return await this.placeOrder(coin, isBuy, roundedPrice, size, 'Market');
    } catch (err) {
      // Fallback: if IOC fails, retry as GTC limit (will rest on book).
      // Known IOC rejection reasons:
      // - "80% from reference price" — stale markPx
      // - "could not immediately match" — no resting orders at this price
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('80%') || msg.includes('reference price') || msg.includes('could not immediately match')) {
        process.stderr.write(`[placeMarketOrder] IOC rejected (${msg}), falling back to GTC limit\n`);
        return this.placeOrder(coin, isBuy, roundedPrice, size, 'Limit');
      }
      throw err;
    }
  }

  async transferUsdClass(amount, toPerp) {
    if (!this.wallet) throw new Error('No wallet configured for signing');

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

    return this._exchangeRequest({ action, nonce, signature });
  }

  async transferBetweenSpotAndPerp(amount, toPerp) {
    return this.transferUsdClass(amount, toPerp);
  }

  /**
   * Withdraw USDC from spot account to an external address on HyperLiquid L1.
   * @param {string} destination - 0x-prefixed destination address
   * @param {number|string} amount - USDC amount to withdraw
   * @returns {Promise<object>} Exchange response
   */
  async withdraw(destination, amount) {
    if (!this.wallet) throw new Error('No wallet configured for signing');

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

    return this._exchangeRequest({ action, nonce, signature });
  }

  /**
   * Cancel an order.
   * @param {string} coin - e.g. "#21460"
   * @param {number} orderId - Order OID
   */
  async cancelOrder(coin, orderId) {
    if (!this.wallet) throw new Error('No wallet configured for signing');

    const assetIndex = await this._resolveSpotAssetIndex(coin);

    const action = {
      type: 'cancel',
      cancels: [{ a: assetIndex, o: Number(orderId) }],
    };

    const nonce = this._nonce();
    const signature = await signL1Action(
      this.wallet,
      action,
      null,
      nonce,
      this.isMainnet,
    );

    return this._exchangeRequest({ action, nonce, signature, vaultAddress: null });
  }

  /**
   * Cancel all open orders.
   */
  async cancelAllOrders() {
    if (!this.wallet) throw new Error('No wallet configured for signing');

    const openOrders = await this.getOpenOrders();
    if (!openOrders || openOrders.length === 0) {
      return { status: 'ok', message: 'No open orders to cancel' };
    }

    const cancels = [];
    for (const order of openOrders) {
      try {
        const assetIndex = await this._resolveSpotAssetIndex(order.coin);
        cancels.push({ a: assetIndex, o: Number(order.oid) });
      } catch {
        // Skip orders for unknown coins
      }
    }

    if (cancels.length === 0) {
      return { status: 'ok', message: 'No cancellable orders found' };
    }

    const action = { type: 'cancel', cancels };
    const nonce = this._nonce();
    const signature = await signL1Action(
      this.wallet,
      action,
      null,
      nonce,
      this.isMainnet,
    );

    return this._exchangeRequest({ action, nonce, signature, vaultAddress: null });
  }

  // ─── Factory ────────────────────────────────────────────────────

  static async create(privateKey, network = 'testnet') {
    const client = new HLClient(privateKey, network);
    return client;
  }

  // ─── Utility ────────────────────────────────────────────────────

  getAddress() {
    return this.address;
  }
}
