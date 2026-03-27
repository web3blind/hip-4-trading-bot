/**
 * HyperLiquid API Client for HIP-4 Outcome Trading
 *
 * Info endpoints are implemented via raw fetch.
 * Exchange endpoints (order placement, cancellation) are stubs
 * pending SDK signing integration in Milestone 1.2/1.4.
 */

import { ethers } from 'ethers';
import { HL_API } from './constants.js';

export class HLClient {
  /**
   * @param {string} privateKey - Hex private key (with or without 0x prefix)
   * @param {string} network - 'testnet' or 'mainnet'
   */
  constructor(privateKey, network = 'testnet') {
    this.network = network;

    if (privateKey) {
      const key = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
      this.wallet = new ethers.Wallet(key);
      this.address = this.wallet.address;
    } else {
      this.wallet = null;
      this.address = null;
    }
  }

  // ─── Internal helpers ───────────────────────────────────────────

  /**
   * POST to the info endpoint.
   * @param {object} body - JSON payload
   * @returns {Promise<any>}
   */
  async _infoRequest(body) {
    const url = this.network === 'testnet' ? HL_API.TESTNET_INFO : HL_API.MAINNET_INFO;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HL API error: ${response.status} ${response.statusText}`);
    return response.json();
  }

  // ─── Info endpoints ─────────────────────────────────────────────

  /**
   * Fetch metadata for all spot assets (including HIP-4 outcomes).
   * Returns the full spotMeta response (universe + tokens).
   */
  async getOutcomeMeta() {
    return this._infoRequest({ type: 'spotMeta' });
  }

  /**
   * Fetch L2 orderbook for a given coin.
   * @param {string} coin - e.g. "#21460" for an outcome coin
   * @returns {Promise<{levels: Array}>}
   */
  async getOrderbook(coin) {
    return this._infoRequest({ type: 'l2Book', coin });
  }

  /**
   * Fetch all mid prices.
   * @returns {Promise<Record<string, string>>} Map of coin -> mid price
   */
  async getAllMids() {
    return this._infoRequest({ type: 'allMids' });
  }

  /**
   * Fetch user spot token balances.
   * @param {string} address - Wallet address
   * @returns {Promise<object>}
   */
  async getUserBalances(address) {
    const addr = address || this.address;
    if (!addr) throw new Error('No address provided and no wallet configured');
    return this._infoRequest({ type: 'spotClearinghouseState', user: addr });
  }

  /**
   * Fetch user fill (trade) history.
   * @param {string} address - Wallet address
   * @returns {Promise<Array>}
   */
  async getUserFills(address) {
    const addr = address || this.address;
    if (!addr) throw new Error('No address provided and no wallet configured');
    return this._infoRequest({ type: 'userFills', user: addr });
  }

  /**
   * Fetch open orders for the user.
   * @param {string} address - Wallet address
   * @returns {Promise<Array>}
   */
  async getOpenOrders(address) {
    const addr = address || this.address;
    if (!addr) throw new Error('No address provided and no wallet configured');
    return this._infoRequest({ type: 'openOrders', user: addr });
  }

  /**
   * Fetch candlestick data.
   * @param {string} coin - e.g. "#21460"
   * @param {string} interval - e.g. "1h", "1d"
   * @param {number} startTime - Unix timestamp (ms)
   * @param {number} endTime - Unix timestamp (ms)
   * @returns {Promise<Array>}
   */
  async getCandles(coin, interval, startTime, endTime) {
    return this._infoRequest({
      type: 'candleSnapshot',
      req: { coin, interval, startTime, endTime },
    });
  }

  // ─── Exchange endpoints (stubs) ─────────────────────────────────

  /**
   * Place an order. Stub — requires SDK signing integration.
   * @param {string} coin
   * @param {boolean} isBuy
   * @param {number} price
   * @param {number} size
   * @param {string} orderType - 'Limit' or 'Market'
   */
  async placeOrder(coin, isBuy, price, size, orderType = 'Limit') {
    throw new Error('Not implemented yet — requires SDK integration (Milestone 1.4)');
  }

  /**
   * Cancel an order. Stub — requires SDK signing integration.
   * @param {string} coin
   * @param {number|string} orderId
   */
  async cancelOrder(coin, orderId) {
    throw new Error('Not implemented yet — requires SDK integration (Milestone 1.4)');
  }

  /**
   * Cancel all open orders. Stub — requires SDK signing integration.
   */
  async cancelAllOrders() {
    throw new Error('Not implemented yet — requires SDK integration (Milestone 1.4)');
  }

  // ─── Utility ────────────────────────────────────────────────────

  /**
   * Get the wallet address.
   * @returns {string|null}
   */
  getAddress() {
    return this.address;
  }
}
