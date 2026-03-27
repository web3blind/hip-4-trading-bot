import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  initDatabase,
  closeDatabase,
  upsertOutcome,
  getOutcomes,
  getOutcomeById,
  getOutcomeCount,
  upsertPosition,
  getPositions,
  deletePosition,
  upsertOrder,
  getOrders,
  getOrderByOid,
  deleteOrder,
} from '../../src/modules/database.js';

describe('database', () => {
  before(() => {
    // Initialize in-memory or file-based DB
    // initDatabase uses file-based, but tables are created fresh
    initDatabase();
  });

  after(() => {
    closeDatabase();
  });

  describe('outcomes', () => {
    it('upserts and retrieves an outcome', () => {
      upsertOutcome({
        outcomeId: 2146,
        question: 'Will BTC hit 100k?',
        description: 'Bitcoin price prediction',
        status: 'active',
        sides: [
          { side: 0, coin: '#21460', token: '+21460', assetId: 100021460 },
          { side: 1, coin: '#21461', token: '+21461', assetId: 100021461 },
        ],
      });

      const outcome = getOutcomeById(2146);
      assert.ok(outcome);
      assert.equal(outcome.outcome_id, 2146);
      assert.equal(outcome.question, 'Will BTC hit 100k?');
      assert.equal(outcome.sides.length, 2);
      assert.equal(outcome.sides[0].coin, '#21460');
      assert.equal(outcome.sides[1].coin, '#21461');
    });

    it('getOutcomes returns paginated results', () => {
      // Add a second outcome
      upsertOutcome({
        outcomeId: 2147,
        question: 'Will ETH hit 10k?',
        description: 'Ethereum prediction',
        status: 'active',
        sides: [],
      });

      const all = getOutcomes(100, 0);
      assert.ok(all.length >= 2);

      const page1 = getOutcomes(1, 0);
      assert.equal(page1.length, 1);

      const page2 = getOutcomes(1, 1);
      assert.equal(page2.length, 1);
    });

    it('getOutcomeCount returns correct count', () => {
      const count = getOutcomeCount();
      assert.ok(count >= 2);
    });

    it('upsert updates existing outcome', () => {
      upsertOutcome({
        outcomeId: 2146,
        question: 'Will BTC hit 100k by end of 2026?',
        description: 'Updated prediction',
        status: 'active',
      });

      const outcome = getOutcomeById(2146);
      assert.equal(outcome.question, 'Will BTC hit 100k by end of 2026?');
    });
  });

  describe('positions', () => {
    it('upserts and retrieves a position', () => {
      upsertPosition({
        coin: '#21460',
        side: 'yes',
        size: '10.5',
        entryPrice: '0.73',
      });

      const positions = getPositions();
      assert.ok(positions.length >= 1);
      const pos = positions.find(p => p.coin === '#21460');
      assert.ok(pos);
      assert.equal(pos.side, 'yes');
      assert.equal(pos.size, '10.5');
      assert.equal(pos.entry_price, '0.73');
    });

    it('deletes a position', () => {
      deletePosition('#21460');
      const positions = getPositions();
      const pos = positions.find(p => p.coin === '#21460');
      assert.equal(pos, undefined);
    });
  });

  describe('orders', () => {
    it('upserts and retrieves an order', () => {
      upsertOrder({
        coin: '#21460',
        side: 'buy',
        orderType: 'Limit',
        price: '0.73',
        size: '10',
        oid: 'test-order-1',
        status: 'open',
      });

      const orders = getOrders();
      assert.ok(orders.length >= 1);
      const order = orders.find(o => o.oid === 'test-order-1');
      assert.ok(order);
      assert.equal(order.coin, '#21460');
      assert.equal(order.side, 'buy');
    });

    it('getOrderByOid returns the correct order', () => {
      const order = getOrderByOid('test-order-1');
      assert.ok(order);
      assert.equal(order.oid, 'test-order-1');
    });

    it('getOrders filters by status', () => {
      const openOrders = getOrders('open');
      assert.ok(openOrders.length >= 1);

      const filledOrders = getOrders('filled');
      assert.equal(filledOrders.length, 0);
    });

    it('deletes an order', () => {
      deleteOrder('test-order-1');
      const order = getOrderByOid('test-order-1');
      assert.equal(order, null);
    });
  });
});
