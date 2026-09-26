// Import this FIRST in every server test file. It registers the resolve hook so
// that dynamic `import('../../src/app/api/.../route.ts')` works under node --test.
import { register } from 'node:module';
register(new URL('./next-resolve-hook.mjs', import.meta.url));
