import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  parsePercentInput,
  parsePositiveNumberInput,
  parseUnitIntervalInput,
  parseNonNegativeIntegerInput,
  normalizeOutcomeSideHint,
  formatPrice,
  formatPricePercent,
  formatUSDC,
  formatOutcomeList,
  formatOutcomeDetail,
  formatPriceBucketQuestionDescription,
  formatEventOutcomes,
  getPriceBucketOutcomeLabel,
  formatPosition,
  formatPositionsList,
  formatOrder,
  formatOrdersList,
} from '../../src/modules/bot/ui/formatters.js';

test('escapeHtml escapes reserved HTML characters', () => {
  assert.equal(
    escapeHtml(`a&<b>"'`),
    'a&amp;&lt;b&gt;&quot;&#39;'
  );
});

test('parsePercentInput parses signed decimal input and rejects invalid values', () => {
  assert.equal(parsePercentInput(' -12,345 '), -12.35);
  assert.equal(parsePercentInput('abc'), null);
});

test('parsePositiveNumberInput parses valid positive input', () => {
  assert.equal(parsePositiveNumberInput('10,5'), 10.5);
  assert.equal(parsePositiveNumberInput('-1'), null);
});

test('parseUnitIntervalInput rounds to requested precision', () => {
  assert.equal(parseUnitIntervalInput('0.123456', 4), 0.1235);
  assert.equal(parseUnitIntervalInput('0', 4), null);
});

test('parseNonNegativeIntegerInput parses integer and rejects non-integer', () => {
  assert.equal(parseNonNegativeIntegerInput(' 42 '), 42);
  assert.equal(parseNonNegativeIntegerInput('4.2'), null);
});

test('normalizeOutcomeSideHint recognizes YES/NO variants', () => {
  assert.equal(normalizeOutcomeSideHint('yes'), 'YES');
  assert.equal(normalizeOutcomeSideHint('нет'), 'NO');
  assert.equal(normalizeOutcomeSideHint('maybe'), null);
});

// ─── New HIP-4 formatter tests ────────────────────────────────

test('formatPrice formats 0-1 price as dollar + percentage', () => {
  assert.equal(formatPrice(0.73), '$0.7300 (73.0%)');
  assert.equal(formatPrice(0), '$0.0000 (0.0%)');
  assert.equal(formatPrice(1), '$1.0000 (100.0%)');
  assert.equal(formatPrice(null), 'N/A');
  assert.equal(formatPrice('abc'), 'N/A');
  assert.equal(formatPrice(undefined), 'N/A');
});

test('formatPricePercent formats 0-1 price as percentage only', () => {
  assert.equal(formatPricePercent(0.73), '73.0%');
  assert.equal(formatPricePercent(0.5), '50.0%');
  assert.equal(formatPricePercent(0), '0.0%');
  assert.equal(formatPricePercent(null), 'N/A');
  assert.equal(formatPricePercent(undefined), 'N/A');
});

test('formatUSDC formats dollar amounts', () => {
  assert.equal(formatUSDC(1234.5), '$1,234.50');
  assert.equal(formatUSDC(0), '$0.00');
  assert.equal(formatUSDC(null), '$0.00');
});

test('formatOutcomeList formats paginated outcome list', () => {
  const outcomes = [
    { question: 'Will BTC hit 100k?', yesPrice: 0.73, noPrice: 0.27 },
    { question: 'Will ETH hit 10k?', yesPrice: 0.45, noPrice: 0.55 },
  ];
  const result = formatOutcomeList(outcomes, 1, 2);
  assert.ok(result.includes('page 1/2'));
  assert.ok(result.includes('Will BTC hit 100k?'));
  assert.ok(result.includes('YES: 73.0%'));
  assert.ok(result.includes('NO: 27.0%'));
  assert.ok(result.includes('Will ETH hit 10k?'));
});

test('formatOutcomeList handles empty list', () => {
  assert.equal(formatOutcomeList([], 1, 1), 'No outcomes found.');
  assert.equal(formatOutcomeList(null, 1, 1), 'No outcomes found.');
});

test('formatOutcomeDetail shows question, prices, spread, and orderbook', () => {
  const outcome = {
    question: 'Will BTC hit 100k?',
    description: 'Bitcoin price prediction',
  };
  const orderbook = {
    bids: [['0.72', '10'], ['0.71', '5']],
    asks: [['0.74', '8'], ['0.75', '3']],
  };
  const prices = { yes: 0.73, no: 0.27 };
  const result = formatOutcomeDetail(outcome, orderbook, prices);
  assert.ok(result.includes('Will BTC hit 100k?'));
  assert.ok(result.includes('YES:'));
  assert.ok(result.includes('NO:'));
  assert.ok(result.includes('Spread:'));
  assert.ok(result.includes('Orderbook (YES)'));
  assert.ok(result.includes('Bids'));
  assert.ok(result.includes('Asks'));
});

test('priceBucket question descriptions and outcome labels are human readable', () => {
  const description = 'class:priceBucket|underlying:BTC|expiry:20260513-0600|priceThresholds:79558,82805|period:1d';

  assert.equal(
    formatPriceBucketQuestionDescription(description).split('\n')[0],
    'BTC price bucket: $79,558 / $82,805',
  );
  assert.equal(getPriceBucketOutcomeLabel(description, 'index:0'), '< $79,558');
  assert.equal(getPriceBucketOutcomeLabel(description, 'index:1'), '$79,558 – $82,805');
  assert.equal(getPriceBucketOutcomeLabel(description, 'index:2'), '> $82,805');
  assert.equal(getPriceBucketOutcomeLabel(description, 'other'), 'Other / fallback');
});

test('formatEventOutcomes uses priceBucket option labels', () => {
  const event = {
    name: 'Recurring',
    description: 'class:priceBucket|underlying:BTC|expiry:20260513-0600|priceThresholds:79558,82805|period:1d',
    outcomes: [
      { name: 'Recurring Named Outcome', displayName: '< $79,558', yesPrice: 0.2, noPrice: 0.8 },
      { name: 'Recurring Named Outcome', displayName: '$79,558 – $82,805', yesPrice: 0.5, noPrice: 0.5 },
      { name: 'Recurring Named Outcome', displayName: '> $82,805', yesPrice: 0.3, noPrice: 0.7 },
    ],
  };

  const result = formatEventOutcomes(event);
  assert.ok(result.includes('BTC price bucket: $79,558 / $82,805'));
  assert.ok(result.includes('< $79,558'));
  assert.ok(result.includes('$79,558 – $82,805'));
  assert.ok(result.includes('> $82,805'));
});

test('formatOutcomeDetail prefers displayName for selected multi-option outcome', () => {
  const result = formatOutcomeDetail(
    { question: 'Recurring Named Outcome', displayName: '$79,558 – $82,805', description: 'index:1' },
    null,
    { yes: 0.5, no: 0.5 },
  );

  assert.ok(result.startsWith('$79,558 – $82,805'));
});

test('formatPosition formats a single position', () => {
  const pos = { coin: '#21460', side: 'yes', size: '10', entry_price: '0.73' };
  const result = formatPosition(pos);
  assert.ok(result.includes('#21460'));
  assert.ok(result.includes('YES'));
  assert.ok(result.includes('10'));
});

test('formatPositionsList handles empty', () => {
  assert.equal(formatPositionsList([]), 'No open positions.');
});

test('formatOrder formats a single order', () => {
  const order = { coin: '#21460', side: 'buy', order_type: 'Limit', price: '0.73', size: '10', status: 'open', oid: 'abc123' };
  const result = formatOrder(order);
  assert.ok(result.includes('#21460'));
  assert.ok(result.includes('BUY'));
  assert.ok(result.includes('Limit'));
  assert.ok(result.includes('abc123'));
});

test('formatOrdersList handles empty', () => {
  assert.equal(formatOrdersList([]), 'No orders.');
});
