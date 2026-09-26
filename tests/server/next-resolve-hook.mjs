// Node's ESM resolver can't resolve the bare "next/server" specifier (Next's CJS
// entry has no "exports" map) and — unlike a bundler — won't resolve a relative
// specifier written without an extension (e.g. "./types", the idiomatic style
// used across src/server/*.ts and Next's own route files). This hook fixes both
// so route handlers and the shared server modules can be imported and exercised
// directly under plain `node --test`, without changing how they're written.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && isRelative && !/\.[a-z]+(\?.*)?$/i.test(specifier)) {
      for (const ext of ['.ts', '.js']) {
        try {
          return await nextResolve(specifier + ext, context);
        } catch {
          // try the next extension
        }
      }
    }
    throw err;
  }
}
