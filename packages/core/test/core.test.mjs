import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { changedFiles, changedFilesForTarget, collectFiles, createTransport, downloadPlan, executeDownload, loadConfig, remotePath, resolveInside, uploadPlan } from '../dist/index.js';

const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ed-test-'));
  dirs.push(dir);
  return dir;
}

const target = {
  driver: 'sftp', host: 'example.com', local: '.', remote: '/srv/app',
  auth: { type: 'ssh-config' },
};

test('配置校验拒绝不存在的默认 Target', async () => {
  const dir = await workspace();
  await writeFile(path.join(dir, 'easy-deploy.json'), JSON.stringify({ version: 1, default: 'prod', targets: { dev: target } }));
  await assert.rejects(loadConfig(dir), /默认 Target 不存在/);
});

test('配置校验拒绝未知字段和错误类型', async () => {
  const dir = await workspace();
  const file = path.join(dir, 'easy-deploy.json');
  await writeFile(file, JSON.stringify({ version: 1, default: 'dev', extra: true, targets: { dev: target } }));
  await assert.rejects(loadConfig(dir), /未知字段/);
  await writeFile(file, JSON.stringify({ version: 1, default: 'dev', targets: { dev: { ...target, protected: 'yes' } } }));
  await assert.rejects(loadConfig(dir), /protected 必须是布尔值/);
  for (const local of ['C:\\project', 'C:project', '\\\\server\\share\\project']) {
    await writeFile(file, JSON.stringify({ version: 1, default: 'dev', targets: { dev: { ...target, local } } }));
    await assert.rejects(loadConfig(dir), /local 必须在配置目录内/);
  }
});

test('自动上传仅允许非受保护目标', async () => {
  const dir = await workspace();
  const file = path.join(dir, 'easy-deploy.json');
  await writeFile(file, JSON.stringify({ version: 1, default: 'dev', targets: { dev: { ...target, uploadOnSave: true } } }));
  assert.equal((await loadConfig(dir)).config.targets.dev.uploadOnSave, true);
  await writeFile(file, JSON.stringify({ version: 1, default: 'dev', targets: { dev: { ...target, protected: true, uploadOnSave: true } } }));
  await assert.rejects(loadConfig(dir), /不能用于受保护目标/);
});

test('密码环境变量缺失时在连接前拒绝 FTP 和 SFTP', async () => {
  const passwordEnv = `ED_TEST_MISSING_PASSWORD_${process.pid}`;
  delete process.env[passwordEnv];
  for (const driver of ['ftp', 'sftp']) {
    const transport = createTransport({ ...target, driver, auth: { type: 'password', passwordEnv } });
    await assert.rejects(transport.connect(), error => error.kind === 'auth' && error.message.includes(passwordEnv));
  }
});

test('路径不能越界，默认排除敏感文件和符号链接', async () => {
  const dir = await workspace();
  await mkdir(path.join(dir, 'app'));
  await writeFile(path.join(dir, 'app', 'main.php'), 'ok');
  await writeFile(path.join(dir, '.env'), 'secret');
  try { await symlink(path.join(dir, 'app'), path.join(dir, 'linked'), 'dir'); }
  catch (error) { if (error.code !== 'EPERM') throw error; }
  assert.throws(() => resolveInside(dir, '../outside'), /超出/);
  assert.throws(() => resolveInside(dir, 'C:\\outside'), /不允许绝对路径/);
  assert.throws(() => resolveInside(dir, 'C:outside'), /不允许绝对路径/);
  assert.equal(remotePath('/srv/app', 'app/main.php'), '/srv/app/app/main.php');
  assert.deepEqual(await collectFiles(dir, target, '.'), ['app/main.php']);
  assert.deepEqual((await uploadPlan(dir, target, ['app'])).map(item => item.remote), ['/srv/app/app/main.php']);
});

test('忽略规则支持目录、通配符和反转，敏感文件始终禁传', async () => {
  const dir = await workspace();
  await mkdir(path.join(dir, 'secret'));
  await writeFile(path.join(dir, '.gitignore'), '*.log\n!keep.log\nsecret/\n');
  await writeFile(path.join(dir, 'app.log'), 'skip');
  await writeFile(path.join(dir, 'keep.log'), 'keep');
  await writeFile(path.join(dir, 'secret', 'file.txt'), 'skip');
  await writeFile(path.join(dir, '.env'), 'blocked');
  assert.deepEqual(await collectFiles(dir, target, '.'), ['.gitignore', 'keep.log']);
});

test('下载拒绝恶意目录项，完成文件使用临时路径', async () => {
  const dir = await workspace();
  const entries = [{ name: 'safe.txt', directory: false }];
  const transport = {
    connect: async () => {}, close: async () => {}, upload: async () => {}, remove: async () => {},
    exists: async () => true,
    isDirectory: async remote => remote === '/srv/app/docs',
    isLink: async () => false,
    list: async () => entries,
    download: async (_remote, local) => { await writeFile(local, 'content'); },
  };
  entries[0].name = '../escape';
  await assert.rejects(downloadPlan(dir, target, 'docs', transport), /目录项无效/);
  await assert.rejects(downloadPlan(dir, target, 'docs/linked/file', { ...transport, isLink: async remote => remote === '/srv/app/docs/linked' }), /远程路径包含符号链接/);
  entries[0].name = 'safe.txt';
  const plan = await downloadPlan(dir, target, 'docs', transport);
  await executeDownload(plan, dir, transport);
  assert.equal(await readFile(path.join(dir, 'docs/safe.txt'), 'utf8'), 'content');
});

test('下载中断保留已有文件并清理临时文件', async () => {
  const dir = await workspace();
  const local = path.join(dir, 'existing.txt');
  await writeFile(local, 'original');
  const transport = {
    download: async (_remote, temporary) => { await writeFile(temporary, 'partial'); throw new Error('connection lost'); },
  };
  await assert.rejects(executeDownload([{ local, remote: '/srv/app/existing.txt', relative: 'existing.txt' }], dir, transport), /connection lost/);
  assert.equal(await readFile(local, 'utf8'), 'original');
  assert.deepEqual(await readdir(dir), ['existing.txt']);
});

test('Git 变更正确处理空格文件名和删除项', async () => {
  const dir = await workspace();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  await writeFile(path.join(dir, 'old name.txt'), 'old');
  await writeFile(path.join(dir, 'delete.txt'), 'delete');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: dir });
  execFileSync('git', ['mv', 'old name.txt', 'new name.txt'], { cwd: dir });
  await rm(path.join(dir, 'delete.txt'));
  const changes = await changedFiles(dir);
  assert.ok(changes.files.includes('new name.txt'));
  assert.ok(changes.deleted.includes('delete.txt'));
  assert.deepEqual((await changedFilesForTarget(dir, { ...target, local: 'subdir' })).files, []);
});
