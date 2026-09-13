import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { startAgentConnection, OUTCOME_BUILDER } from '../src/modules/agent-connection.js';
import { loadConfig, setSessionConfig } from '../src/modules/config.js';
import { acquireRuntimeLock } from '../src/modules/process-lock.js';
import { HLClient } from '../src/modules/hyperliquid.js';
import { initBot, startBot, stopBot } from '../src/modules/bot/bot.js';
import { activateHLClient, invalidateUserState, userStates, setHLClient } from '../src/modules/bot/runtime.js';
import { stopWorkers } from '../src/modules/workers.js';
import { closeDatabase } from '../src/modules/database.js';
import { patchConsoleForRedaction, flushLogger } from '../src/modules/logger.js';
import { applyProxyRuntime } from '../src/modules/proxy.js';

// Keep the approval -> owner/client/config boundary shared by CLI and offline tests.
export async function activateConnectedAgent(session, existing, {
  init = initBot, activate = activateHLClient, start = startBot, onFatal,
} = {}) {
  if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) throw new Error('Agent approval expired');
  const client = await HLClient.create(session.privateKey, session.network, {
    accountAddress: session.accountAddress, authMode: 'agent',
    builder: session.builderEnabled ? { b: OUTCOME_BUILDER, f: 0 } : undefined,
  });
  if (client.wallet.address.toLowerCase() !== session.agentAddress.toLowerCase()) throw new Error('Agent identity mismatch');
  setSessionConfig({ ...existing, encrypted: { privateKey: '' }, walletAddress: session.accountAddress,
    authMode: 'agent', agentAddress: session.agentAddress, hlNetwork: session.network,
    outcomeBuilderEnabled: session.builderEnabled, agentValidUntil: session.expiresAt });
  try {
    await init(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_ALLOWED_USER_ID);
    await activate(client);
    await start({ onFatal });
    return client;
  } catch (error) { setSessionConfig(null); throw error; }
}

// Exported entry point also permits isolated startup tests without polling Telegram.
export async function runAgentConnector({ port = 8787, onConnected, fetchImpl } = {}) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !/^\d+$/.test(process.env.TELEGRAM_ALLOWED_USER_ID || '')) {
    throw new Error('Configure TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID first');
  }
  const releaseLock = await acquireRuntimeLock();
  let existing;
  try { existing = await loadConfig(); } catch (error) { releaseLock(); throw error; }
  let expirationTimer;
  let stopped = false;
  let app;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(expirationTimer);
    setHLClient(null);
    for (const id of userStates.keys()) await invalidateUserState(id);
    await stopWorkers();
    await stopBot();
    setHLClient(null);
    closeDatabase();
    setSessionConfig(null);
    await app?.close();
    await flushLogger(1500);
    releaseLock();
  };
  try {
  app = await startAgentConnection({ port, fetchImpl, onConnected: async session => {
    if (onConnected) { await onConnected(session); return; }
    try {
      await activateConnectedAgent(session, existing, { onFatal: () => stop().finally(() => process.exit(1)) });
      expirationTimer = setTimeout(() => { void stop().finally(() => process.exit(0)); }, Math.max(1, session.expiresAt - Date.now()));
      expirationTimer.unref();
      console.log(`HIP-4 agent connected (${session.network}); use /start in the private Telegram chat.`);
    } catch (error) { await stop(); throw error; }
  } });
  } catch (error) { await stop(); throw error; }
  const signalHandlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => { void stop().finally(() => process.exit(0)); };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  return { ...app, stop: async () => {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    await stop();
  } };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.includes('--help')) {
    console.log('npm run connect — ephemeral agent connection on http://127.0.0.1:8787. Open the printed local URL in your wallet browser. Never enter a private key. Use an SSH tunnel when running on a server.');
  } else {
    patchConsoleForRedaction();
    applyProxyRuntime();
    runAgentConnector().then(app => {
      console.log('Open this private local connection link in your wallet browser. Do not share it:');
      console.log(app.url);
    }).catch(() => { console.error('Connector could not start. Check .env, runtime.lock and local port 8787. No account was connected.'); process.exitCode = 1; });
  }
}
