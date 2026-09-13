// Preloaded by the test harness. Tests must stub exchange providers explicitly.
const originalFetch = globalThis.fetch;
globalThis.fetch = function offlineFetch(input, options) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Offline test blocked external network; mock the provider boundary');
  }
  return originalFetch(input, options);
};
