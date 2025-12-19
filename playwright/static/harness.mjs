// Load the browser-safe web build and expose it to tests.
// If the module fails to load, capture the error so Playwright can surface it.
(async () => {
  try {
    const web = await import('/dist/web/index.js');
    globalThis.__WEB__ = web;
  } catch (e) {
    globalThis.__WEB_ERROR__ = e instanceof Error ? e.stack ?? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error('Failed to load /dist/web/index.js', e);
  }
})();

