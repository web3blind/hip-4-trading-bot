import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeOutcome,
  decodeOutcome,
  toCoin,
  toToken,
  toAssetId,
  coinToOutcome,
  isOutcomeCoin,
  parseOutcomeDescription,
  SIDES,
} from '../../src/modules/hl-encoding.js';

describe('hl-encoding', () => {
  describe('encodeOutcome', () => {
    it('encodes YES side correctly', () => {
      assert.equal(encodeOutcome(2146, 0), 21460);
    });

    it('encodes NO side correctly', () => {
      assert.equal(encodeOutcome(2146, 1), 21461);
    });

    it('encodes outcomeId 0 correctly', () => {
      assert.equal(encodeOutcome(0, 0), 0);
      assert.equal(encodeOutcome(0, 1), 1);
    });

    it('encodes large outcomeId correctly', () => {
      assert.equal(encodeOutcome(99999, 0), 999990);
      assert.equal(encodeOutcome(99999, 1), 999991);
    });

    it('throws for invalid side', () => {
      assert.throws(() => encodeOutcome(100, 2), /Invalid side: 2/);
      assert.throws(() => encodeOutcome(100, -1), /Invalid side: -1/);
      assert.throws(() => encodeOutcome(100, 'YES'), /Invalid side: YES/);
    });
  });

  describe('decodeOutcome', () => {
    it('decodes YES encoding', () => {
      const result = decodeOutcome(21460);
      assert.deepEqual(result, { outcomeId: 2146, side: 0, sideName: 'YES' });
    });

    it('decodes NO encoding', () => {
      const result = decodeOutcome(21461);
      assert.deepEqual(result, { outcomeId: 2146, side: 1, sideName: 'NO' });
    });

    it('round-trips with encodeOutcome', () => {
      for (const outcomeId of [0, 1, 42, 2146, 99999]) {
        for (const side of [0, 1]) {
          const encoded = encodeOutcome(outcomeId, side);
          const decoded = decodeOutcome(encoded);
          assert.equal(decoded.outcomeId, outcomeId);
          assert.equal(decoded.side, side);
        }
      }
    });
  });

  describe('toCoin', () => {
    it('returns # prefixed encoding', () => {
      assert.equal(toCoin(2146, 0), '#21460');
      assert.equal(toCoin(2146, 1), '#21461');
    });
  });

  describe('toToken', () => {
    it('returns + prefixed encoding', () => {
      assert.equal(toToken(2146, 0), '+21460');
      assert.equal(toToken(2146, 1), '+21461');
    });
  });

  describe('toAssetId', () => {
    it('returns 100_000_000 + encoding', () => {
      assert.equal(toAssetId(2146, 0), 100021460);
      assert.equal(toAssetId(2146, 1), 100021461);
    });

    it('works for outcomeId 0', () => {
      assert.equal(toAssetId(0, 0), 100000000);
      assert.equal(toAssetId(0, 1), 100000001);
    });
  });

  describe('coinToOutcome', () => {
    it('parses valid coin strings', () => {
      const result = coinToOutcome('#21460');
      assert.deepEqual(result, { outcomeId: 2146, side: 0, sideName: 'YES' });
    });

    it('parses NO coin strings', () => {
      const result = coinToOutcome('#21461');
      assert.deepEqual(result, { outcomeId: 2146, side: 1, sideName: 'NO' });
    });

    it('accepts outcome token aliases but rejects ordinary spot and malformed coins', () => {
      assert.deepEqual(coinToOutcome('+21460'), coinToOutcome('#21460'));
      for (const coin of ['@21460', '#21460abc', '#21462', '21460']) {
        assert.throws(() => coinToOutcome(coin));
      }
    });
  });

  describe('isOutcomeCoin', () => {
    it('returns true for valid outcome coins', () => {
      assert.equal(isOutcomeCoin('#21460'), true);
      assert.equal(isOutcomeCoin('#0'), true);
      assert.equal(isOutcomeCoin('#999991'), true);
    });

    it('returns false for non-outcome coins', () => {
      assert.equal(isOutcomeCoin('+21460'), true);
      assert.equal(isOutcomeCoin('@21460'), false);
      assert.equal(isOutcomeCoin('#21462'), false);
      assert.equal(isOutcomeCoin('BTC'), false);
      assert.equal(isOutcomeCoin('#'), false);
      assert.equal(isOutcomeCoin('#abc'), false);
      assert.equal(isOutcomeCoin(''), false);
      assert.equal(isOutcomeCoin(null), false);
      assert.equal(isOutcomeCoin(undefined), false);
      assert.equal(isOutcomeCoin(123), false);
    });
  });

  describe('parseOutcomeDescription', () => {
    it('parses a standard PriceBinary description', () => {
      const desc = 'class:priceBinary|underlying:BTC|expiry:20260326-0300|targetPrice:70836|period:1d';
      const result = parseOutcomeDescription(desc);
      assert.deepEqual(result, {
        class: 'priceBinary',
        underlying: 'BTC',
        expiry: '20260326-0300',
        targetPrice: '70836',
        period: '1d',
      });
    });

    it('returns null for null/undefined/empty input', () => {
      assert.equal(parseOutcomeDescription(null), null);
      assert.equal(parseOutcomeDescription(undefined), null);
      assert.equal(parseOutcomeDescription(''), null);
    });

    it('handles single key-value pair', () => {
      const result = parseOutcomeDescription('class:priceBinary');
      assert.deepEqual(result, { class: 'priceBinary' });
    });

    it('handles keys with empty values', () => {
      const result = parseOutcomeDescription('key:');
      assert.deepEqual(result, { key: '' });
    });
  });

  describe('SIDES constant', () => {
    it('has correct values', () => {
      assert.equal(SIDES.YES, 0);
      assert.equal(SIDES.NO, 1);
    });
  });
});
