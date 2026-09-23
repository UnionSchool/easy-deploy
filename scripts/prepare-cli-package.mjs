import { copyFile } from 'node:fs/promises';

for (const name of ['README.md', 'LICENSE']) {
  await copyFile(new URL(`../${name}`, import.meta.url), new URL(`../packages/cli/${name}`, import.meta.url));
}
