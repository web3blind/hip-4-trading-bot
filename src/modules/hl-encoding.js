/**
 * HIP-4 Outcome Encoding Utilities
 * 
 * Encoding formula: encoding = 10 * outcomeId + side
 * side: 0 = YES, 1 = NO
 * coin format: "#" + encoding (e.g. "#21460")
 * token format: "+" + encoding (e.g. "+21460")
 * asset ID: 100_000_000 + encoding (e.g. 100021460)
 */

export function encodeOutcome(outcomeId, side) {
  if (side !== 0 && side !== 1) throw new Error(`Invalid side: ${side}. Must be 0 (YES) or 1 (NO)`);
  const id = Number(outcomeId);
  if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(100_000_000 + 10 * id + side)) throw new Error('Invalid outcome ID');
  return 10 * id + side;
}

export function decodeOutcome(encoding) {
  if (!Number.isSafeInteger(encoding) || encoding < 0 || ![0, 1].includes(encoding % 10)) throw new Error('Invalid outcome encoding');
  const side = encoding % 10;
  const outcomeId = (encoding - side) / 10;
  return { outcomeId, side, sideName: side === 0 ? 'YES' : 'NO' };
}

export function toCoin(outcomeId, side) {
  return '#' + encodeOutcome(outcomeId, side);
}

export function toToken(outcomeId, side) {
  return '+' + encodeOutcome(outcomeId, side);
}

export function toAssetId(outcomeId, side) {
  return 100_000_000 + encodeOutcome(outcomeId, side);
}

export function coinToOutcome(coin) {
  if (!isOutcomeCoin(coin)) throw new Error(`Invalid coin format: ${coin}`);
  return decodeOutcome(Number(coin.slice(1)));
}

export function isOutcomeCoin(coin) {
  return typeof coin === 'string' && /^[#+](0|[1-9][0-9]*)$/.test(coin)
    && Number.isSafeInteger(100_000_000 + Number(coin.slice(1)))
    && [0, 1].includes(Number(coin.slice(1)) % 10);
}

export function normalizeOutcomeCoin(coin) {
  return isOutcomeCoin(coin) ? '#' + coin.slice(1) : coin;
}

// Parse PriceBinary description string
// e.g. "class:priceBinary|underlying:BTC|expiry:20260326-0300|targetPrice:70836|period:1d"
export function parseOutcomeDescription(description) {
  if (!description) return null;
  const parts = {};
  for (const segment of description.split('|')) {
    const [key, value] = segment.split(':');
    if (key && value !== undefined) {
      parts[key] = value;
    }
  }
  return parts;
}

export const SIDES = { YES: 0, NO: 1 };
