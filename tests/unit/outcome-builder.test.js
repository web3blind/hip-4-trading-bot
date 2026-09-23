import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import { verifyOutcomeBuilderApproval, OUTCOME_BUILDER, outcomeBuilderStatusKey } from '../../src/modules/outcome-builder.js';
import { HLClient } from '../../src/modules/hyperliquid.js';
import { importWallet } from '../../src/modules/auth.js';
import { createConfiguredHLClient } from '../../src/modules/bot/runtime.js';

const owner = new ethers.Wallet('0x' + '11'.repeat(32));
const agent = new ethers.Wallet('0x' + '22'.repeat(32));
const approved = { enabled: true, status: 'approved', builder: OUTCOME_BUILDER, fee: 0 };
const denied = status => ({ enabled: false, status, builder: OUTCOME_BUILDER, fee: 0 });

function infoFetch({ maxFee = 0, builders = [OUTCOME_BUILDER], fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body });
    if (fail) throw new Error('offline');
    if (body.type === 'maxBuilderFee') return new Response(JSON.stringify(maxFee));
    if (body.type === 'approvedBuilders') return new Response(JSON.stringify(builders));
    throw new Error(`unexpected info ${body.type}`);
  };
  return { calls, fetchImpl };
}

function orderClient(network, verifier) {
  const client = new HLClient(agent.privateKey, network, {
    accountAddress: owner.address,
    authMode: 'agent',
    outcomeBuilderVerifier: verifier,
  });
  client._roundSize = async (_coin, size) => size;
  client._getSzDecimals = async () => 0;
  client._resolveSpotAssetIndex = async coin => coin === '#300' ? 100000300 : 100000301;
  return client;
}

const order = (coin = '#300') => ({ coin, isBuy: true, price: 0.42, size: 10, orderType: 'Limit' });
const ok = count => ({ status: 'ok', response: { type: 'order', data: { statuses: Array.from({ length: count }, (_, i) => ({ resting: { oid: i + 1 } })) } } });

test('official info responses require approvedBuilders membership and a valid numeric maxBuilderFee', async () => {
  const fixture = infoFetch();
  const result = await verifyOutcomeBuilderApproval({ accountAddress: owner.address, network: 'mainnet', fetchImpl: fixture.fetchImpl });
  assert.deepEqual(result, approved);
  assert.deepEqual(fixture.calls.map(call => call.body.type).sort(), ['approvedBuilders', 'maxBuilderFee']);
  assert.ok(fixture.calls.every(call => call.body.user === owner.address));
  assert.equal(fixture.calls.find(call => call.body.type === 'maxBuilderFee').body.builder, OUTCOME_BUILDER);

  assert.equal((await verifyOutcomeBuilderApproval({ accountAddress: owner.address, network: 'mainnet', fetchImpl: infoFetch({ builders: [] }).fetchImpl })).status, 'not_approved');
  assert.equal((await verifyOutcomeBuilderApproval({ accountAddress: owner.address, network: 'mainnet', fetchImpl: infoFetch({ maxFee: 1 }).fetchImpl })).status, 'approved');
  assert.equal((await verifyOutcomeBuilderApproval({ accountAddress: owner.address, network: 'mainnet', fetchImpl: infoFetch({ maxFee: 0.01 }).fetchImpl })).status, 'approved');
  assert.equal((await verifyOutcomeBuilderApproval({ accountAddress: owner.address, network: 'mainnet', fetchImpl: infoFetch({ maxFee: '0' }).fetchImpl })).status, 'unavailable');
  assert.equal((await verifyOutcomeBuilderApproval({ accountAddress: owner.address, network: 'mainnet', fetchImpl: infoFetch({ builders: [{ builder: OUTCOME_BUILDER }] }).fetchImpl })).status, 'unavailable');
  assert.equal((await verifyOutcomeBuilderApproval({ accountAddress: owner.address, network: 'mainnet', fetchImpl: infoFetch({ fail: true }).fetchImpl })).status, 'unavailable');
});

test('testnet is network-bound and never queries or enables Outcome builder', async () => {
  let calls = 0;
  const status = await verifyOutcomeBuilderApproval({ accountAddress: owner.address, network: 'testnet', fetchImpl: async () => { calls++; } });
  assert.deepEqual(status, denied('mainnet_only'));
  assert.equal(calls, 0);

  const client = orderClient('testnet', async () => { calls++; return approved; });
  let payload;
  client._exchangeRequest = async sent => { payload = sent; return ok(1); };
  await client.placeOrder('#300', true, 0.42, 10, 'Limit');
  assert.equal(calls, 0);
  assert.equal(payload.action.builder, undefined);
  assert.equal(client.outcomeBuilderStatus, 'mainnet_only');
});

test('existing standalone client with explicitly configured builder remains supported', async () => {
  const client = new HLClient(agent.privateKey, 'mainnet', {
    accountAddress: owner.address, authMode: 'agent', builder: { b: OUTCOME_BUILDER, f: 0 },
  });
  client._roundSize = async (_coin, size) => size;
  client._getSzDecimals = async () => 0;
  client._resolveSpotAssetIndex = async () => 100000300;
  let payload;
  client._exchangeRequest = async sent => { payload = sent; return ok(1); };
  await client.placeOrders([order()]);
  assert.deepEqual(payload.action.builder, { b: OUTCOME_BUILDER, f: 0 });
});

test('single and batch mainnet orders recheck approval and carry the exact zero-fee builder', async () => {
  for (const requests of [[order()], [order(), order('#301')]]) {
    let checks = 0; let payload;
    const client = orderClient('mainnet', async () => { checks++; return approved; });
    client._exchangeRequest = async sent => { payload = sent; return ok(requests.length); };
    await client.placeOrders(requests);
    assert.equal(checks, 1);
    assert.deepEqual(payload.action.builder, { b: OUTCOME_BUILDER, f: 0 });
    assert.equal(payload.action.orders.length, requests.length);
    assert.equal(payload.vaultAddress, null);
  }
});

test('revocation, ambiguous response and outage clear stale builder without blocking ordinary trades', async () => {
  for (const response of [denied('not_approved'), denied('unavailable'), () => { throw new Error('offline'); }]) {
    let payload;
    const client = orderClient('mainnet', typeof response === 'function' ? response : async () => response);
    client.builder = { b: OUTCOME_BUILDER, f: 0 };
    client._exchangeRequest = async sent => { payload = sent; return ok(1); };
    await client.placeOrders([order()]);
    assert.equal(client.builder, null);
    assert.equal(payload.action.builder, undefined);
  }
});

test('startup client uses owner rather than API signer, updates persisted flag, and keeps verifier account-bound', async () => {
  const imported = await importWallet(agent.privateKey);
  const config = {
    authMode: 'agent', walletAddress: owner.address, agentAddress: agent.address,
    agentValidUntil: Date.now() + 86_400_000, hlNetwork: 'mainnet', outcomeBuilderEnabled: false,
    encrypted: { privateKey: imported.encryptedPrivateKey },
  };
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    if (body.type === 'extraAgents') return new Response(JSON.stringify([{ address: agent.address, validUntil: config.agentValidUntil }]));
    if (body.type === 'maxBuilderFee') return new Response('0');
    if (body.type === 'approvedBuilders') return new Response(JSON.stringify([OUTCOME_BUILDER]));
    throw new Error(`unexpected ${body.type}`);
  };
  let persisted;
  const client = await createConfiguredHLClient(config, { fetchImpl, persistBuilderStatus: async value => { persisted = value; } });
  assert.equal(client.address, owner.address);
  assert.equal(client.wallet.address, agent.address);
  assert.deepEqual(client.builder, { b: OUTCOME_BUILDER, f: 0 });
  assert.equal(persisted.outcomeBuilderEnabled, true);
  assert.ok(calls.filter(body => body.type === 'maxBuilderFee' || body.type === 'approvedBuilders').every(body => body.user === owner.address));

  const outage = await createConfiguredHLClient({ ...config, outcomeBuilderEnabled: true }, {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.type === 'extraAgents') return new Response(JSON.stringify([{ address: agent.address, validUntil: config.agentValidUntil }]));
      throw new Error('info unavailable');
    },
    persistBuilderStatus: async value => { persisted = value; },
  });
  assert.equal(outage.builder, null);
  assert.equal(outage.outcomeBuilderStatus, 'unavailable');
  assert.equal(persisted.outcomeBuilderEnabled, false);
});

test('status keys are explicit for every verification outcome', () => {
  for (const status of ['approved', 'not_approved', 'unavailable', 'mainnet_only']) {
    assert.match(outcomeBuilderStatusKey(status), /^outcome_builder_/);
  }
});
