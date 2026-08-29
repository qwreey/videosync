// Two jobs: kick the worker off once, and expose the worker's own log to the
// driver. Reading chrome.storage.local does NOT wake the service worker, which
// is the only reason this measurement means anything.
chrome.runtime.sendMessage({ t: 'start', silent: location.hash.includes('silent') }, () => {
  document.documentElement.setAttribute('data-vsl-started', '1');
});

setInterval(async () => {
  const { log = [] } = await chrome.storage.local.get('log');
  document.documentElement.setAttribute('data-vsl-log', JSON.stringify(log));
}, 2000);
