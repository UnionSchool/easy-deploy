import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  noExternal: ['@unionschool/easy-deploy-core'],
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
});
