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
  return 10 * outcomeId + side;
}

export function decodeOutcome(encoding) {
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
  if (!coin.startsWith('#')) throw new Error(`Invalid coin format: ${coin}`);
  return decodeOutcome(parseInt(coin.slice(1), 10));
}

export function isOutcomeCoin(coin) {
  return typeof coin === 'string' && coin.startsWith('#') && !isNaN(parseInt(coin.slice(1), 10));
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
