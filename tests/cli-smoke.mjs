import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../packages/cli/dist/index.js', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../packages/cli/package.json', import.meta.url), 'utf8'));
const project = await mkdtemp(path.join(tmpdir(), 'easy deploy 中文 '));

function run(...args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: project, encoding: 'utf8', timeout: 10000 });
  if (result.error) throw result.error;
  return { code: result.status, output: JSON.parse(result.stdout) };
}

try {
  assert.equal(run('--version').output, version);
  assert.equal(run('init').code, 0);
  const configFile = path.join(project, 'easy-deploy.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.targets.dev.protected = true;
  await writeFile(configFile, JSON.stringify(config));

  const folder = '空格 目录';
  const name = '中文 文件.txt';
  await mkdir(path.join(project, folder));
  await writeFile(path.join(project, folder, name), 'test');

  assert.deepEqual(run('targets'), { code: 0, output: { apiVersion: 1, default: 'dev', targets: ['dev'] } });
  assert.equal(run('status').output.protected, true);
  const plan = run('up', folder, '--dry-run');
  assert.equal(plan.code, 0);
  assert.deepEqual(plan.output.items.map(item => item.remote), ['/srv/project/空格 目录/中文 文件.txt']);
  const blocked = run('up', folder);
  assert.equal(blocked.code, 3);
  assert.equal(blocked.output.error, 'protected');
  assert.equal(run('status', '-t', 'missing').output.error, 'config');
  console.log('CLI cross-platform smoke test passed');
} finally {
  await rm(project, { recursive: true, force: true });
}
