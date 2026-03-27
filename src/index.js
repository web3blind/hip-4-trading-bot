import 'dotenv/config';
import { loadConfig, ensureConfigFileExists } from './modules/config.js';
import { initBot, startBot, stopBot } from './modules/bot/bot.js';
import { initDatabase } from './modules/database.js';
import {
  patchConsoleForRedaction,
  createContext,
  safeLogError,
  safeLogInfo,
  flushLogger
} from './modules/logger.js';
import { startWorkers, stopWorkers } from './modules/workers.js';
import { applyProxyRuntime } from './modules/proxy.js';
import { HLClient } from './modules/hyperliquid.js';
import { getDecryptedPrivateKey } from './modules/auth.js';
import { setHLClient } from './modules/bot/runtime.js';

// Patch console first to catch any SDK secret leakage
patchConsoleForRedaction();

const proxyRuntime = applyProxyRuntime();

// Check for bootstrap mode
const isBootstrap = process.argv.includes('--bootstrap');
let isShuttingDown = false;

async function shutdown(signal = 'unknown', exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const ctx = createContext('index', 'shutdown');
  safeLogInfo(ctx, 'Shutting down application', { signal, exitCode });

  try {
    stopWorkers();
  } catch (error) {
    safeLogError(ctx, error, { stage: 'stopWorkers' });
  }

  try {
    stopBot();
  } catch (error) {
    safeLogError(ctx, error, { stage: 'stopBot' });
  }

  try {
    await flushLogger(1500);
  } catch {}

  process.exit(exitCode);
}

function setupProcessHandlers() {
  process.once('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });

  process.on('unhandledRejection', (reason) => {
    const ctx = createContext('index', 'unhandledRejection');
    safeLogError(ctx, reason, { signal: 'unhandledRejection' });
    void shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (error) => {
    const ctx = createContext('index', 'uncaughtException');
    safeLogError(ctx, error, { signal: 'uncaughtException' });
    void shutdown('uncaughtException', 1);
  });
}

async function main() {
  try {
    setupProcessHandlers();
    const ctx = createContext('index', 'main');
    safeLogInfo(ctx, 'Proxy runtime configured', {
      enabled: proxyRuntime.enabled,
      proxy: proxyRuntime.enabled ? proxyRuntime.redacted : 'disabled',
    });

    if (isBootstrap) {
      safeLogInfo(ctx, 'Running in bootstrap mode');
      await runBootstrap();
    } else {
      safeLogInfo(ctx, 'Starting HyperLiquid HIP-4 Trading Bot');
      await runBot();
    }
  } catch (error) {
    const ctx = createContext('index', 'main');
    safeLogError(ctx, error, { stage: 'main' });
    await shutdown('main_error', 1);
  }
}

// Bootstrap mode - sanity check
async function runBootstrap() {
  const ctx = createContext('index', 'runBootstrap');
  safeLogInfo(ctx, 'Bootstrap: loading config');

  const config = await loadConfig();
  safeLogInfo(ctx, 'Config loaded successfully', {
    walletAddress: config.walletAddress || 'not configured'
  });

  const { getMachineKey, encrypt, decrypt } = await import('./modules/auth.js');
  const machineKey = await getMachineKey();
  const testEncrypted = await encrypt('test-value', machineKey);
  const testDecrypted = await decrypt(testEncrypted, machineKey);
  if (testDecrypted !== 'test-value') throw new Error('Encrypt/decrypt round-trip failed');
  safeLogInfo(ctx, 'auth.js OK');

  safeLogInfo(ctx, 'Bootstrap OK');
  process.exit(0);
}

// Bot mode
async function runBot() {
  const ctx = createContext('index', 'runBot');

  // Validate environment
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const allowedUserId = process.env.TELEGRAM_ALLOWED_USER_ID;

  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN not set in environment');
  }

  if (!allowedUserId) {
    throw new Error('TELEGRAM_ALLOWED_USER_ID not set in environment');
  }

  // 1) Init database
  safeLogInfo(ctx, 'Initializing database');
  initDatabase();
  safeLogInfo(ctx, 'Database initialized');

  // 2) Load / ensure config
  safeLogInfo(ctx, 'Loading config');
  const config = await ensureConfigFileExists();
  safeLogInfo(ctx, 'Config ready', {
    walletAddress: config?.walletAddress || 'not configured',
    network: config?.hlNetwork || 'testnet',
  });

  // 3) Init HyperLiquid client (if wallet is configured)
  let hlClient = null;
  if (config?.walletAddress && config?.encrypted?.privateKey) {
    try {
      safeLogInfo(ctx, 'Initializing HyperLiquid client');
      const privateKey = await getDecryptedPrivateKey();
      const network = config.hlNetwork || 'testnet';
      hlClient = await HLClient.create(privateKey, network);
      setHLClient(hlClient);
      safeLogInfo(ctx, 'HyperLiquid client initialized', { network });
    } catch (error) {
      safeLogError(ctx, error, { stage: 'hlClientInit' });
      safeLogInfo(ctx, 'Continuing without HyperLiquid client (wallet may not be configured)');
    }
  } else {
    safeLogInfo(ctx, 'Wallet not configured — skipping HyperLiquid client init');
  }

  // 4) Init bot
  safeLogInfo(ctx, 'Initializing bot');
  await initBot(botToken, allowedUserId);
  safeLogInfo(ctx, 'Bot initialized');

  // 5) Start bot polling
  safeLogInfo(ctx, 'Starting bot');
  startBot();

  // 6) Start workers (if HL client is available)
  if (hlClient) {
    safeLogInfo(ctx, 'Starting background workers');
    startWorkers({
      hlClient,
      chatId: allowedUserId,
    });
  } else {
    safeLogInfo(ctx, 'Skipping workers (no HyperLiquid client)');
  }

  safeLogInfo(ctx, 'Bot is running');
}

main();
