import test from 'node:test';
import assert from 'node:assert/strict';

import { HLClient } from '../../src/modules/hyperliquid.js';

test('placeOrders submits multiple order wires in one exchange action', async () => {
  const client = new HLClient('0x0000000000000000000000000000000000000000000000000000000000000001', 'testnet');
  client.getOutcomeMeta = async () => ({ outcomes: [{ outcome: 30, quoteToken: 'USDC', szDecimals: 0 }] });
  client._roundSize = async (_coin, size) => size;
  client._resolveSpotAssetIndex = async (coin) => (coin === '#300' ? 100000300 : 100000301);

  let capturedPayload = null;
  client._exchangeRequest = async (payload) => {
    capturedPayload = payload;
    return {
      status: 'ok',
      response: {
        type: 'order',
        data: {
          statuses: [
            { resting: { oid: 1 } },
            { resting: { oid: 2 } },
          ],
        },
      },
    };
  };

  const result = await client.placeOrders([
    { coin: '#300', isBuy: true, price: 0.42, size: 10, orderType: 'Limit' },
    { coin: '#301', isBuy: true, price: 0.55, size: 10, orderType: 'Limit' },
  ]);

  assert.equal(result.status, 'ok');
  assert.equal(capturedPayload.action.type, 'order');
  assert.equal(capturedPayload.action.grouping, 'na');
  assert.equal(capturedPayload.action.orders.length, 2);
  assert.deepEqual(capturedPayload.action.orders.map(o => o.a), [100000300, 100000301]);
  assert.deepEqual(capturedPayload.action.orders.map(o => o.b), [true, true]);
  assert.deepEqual(capturedPayload.action.orders.map(o => o.p), ['0.42', '0.55']);
  assert.deepEqual(capturedPayload.action.orders.map(o => o.s), ['10', '10']);
});

test('placeOrders throws with indexed order errors and preserves HL result', async () => {
  const client = new HLClient('0x0000000000000000000000000000000000000000000000000000000000000001', 'testnet');
  client.getOutcomeMeta = async () => ({ outcomes: [{ outcome: 30, quoteToken: 'USDC', szDecimals: 0 }] });
  client._roundSize = async (_coin, size) => size;
  client._resolveSpotAssetIndex = async () => 100000300;
  client._exchangeRequest = async () => ({
    status: 'ok',
    response: {
      type: 'order',
      data: {
        statuses: [
          { resting: { oid: 1 } },
          { error: 'insufficient balance' },
        ],
      },
    },
  });

  await assert.rejects(
    () => client.placeOrders([
      { coin: '#300', isBuy: true, price: 0.42, size: 10, orderType: 'Limit' },
      { coin: '#301', isBuy: true, price: 0.55, size: 10, orderType: 'Limit' },
    ]),
    (err) => {
      assert.equal(err.message, 'insufficient balance');
      assert.deepEqual(err.orderErrors, [{ index: 1, error: 'insufficient balance' }]);
      assert.equal(err.hlResult.status, 'ok');
      return true;
    },
  );
});
