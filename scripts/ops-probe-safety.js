export function assertLiveTestnet(network, argv = process.argv.slice(2)) {
  if (network !== 'testnet') throw new Error('Live probes deny mainnet and unknown networks.');
  if (!argv.includes('--allow-live-testnet')) throw new Error('Live testnet requires explicit --allow-live-testnet approval.');
}
export function refuseLegacyProbe() {
  console.error('Retired unsafe legacy probe: no orders, cancellations, transfers or faucet actions executed. Use node scripts/ops-catalog-probe.js for maintained read-only metadata inspection. Live probes must deny mainnet and require --allow-live-testnet; this probe refuses even with that flag.');
  process.exitCode = 1;
}
