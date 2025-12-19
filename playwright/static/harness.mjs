import * as web from '/dist/web/index.js';

// Expose the browser-safe web build to page scripts without relying on dynamic imports
// (which TypeScript would try to resolve at compile-time in test sources).
globalThis.__WEB__ = web;

