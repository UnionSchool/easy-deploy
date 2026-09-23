const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const Module = require('node:module');
const path = require('node:path');

const [project, remote] = process.argv.slice(2);
const commands = new Map();
const errors = [];
const state = new Map();
const secrets = new Map();
let answer;
let picked;
let input;
let cancelAfterFirst = false;
let savedDocument;
const folder = { name: 'project', uri: uri(project) };
function uri(fsPath) { return { fsPath, toString: () => `file://${fsPath}` }; }
const vscode = {
  Uri: { file: uri },
  ProgressLocation: { Notification: 1 },
  workspace: {
    workspaceFolders: [folder],
    textDocuments: [],
    onDidSaveTextDocument: handler => { savedDocument = handler; return { dispose() {} }; },
    getWorkspaceFolder: resource => resource.fsPath === project || resource.fsPath.startsWith(`${project}${path.sep}`) ? folder : undefined,
  },
  commands: { registerCommand: (name, handler) => { commands.set(name, handler); return { dispose() {} }; } },
  window: {
    createStatusBarItem: () => ({ show() {}, hide() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    showInformationMessage: () => {},
    showErrorMessage: message => { errors.push(message); },
    showWarningMessage: async () => answer,
    showQuickPick: async () => picked,
    showInputBox: async () => input,
    withProgress: async (_options, task) => {
      let completed = 0;
      return task({ report: () => { completed++; } }, { get isCancellationRequested() { return cancelAfterFirst && completed > 0; } });
    },
  },
  StatusBarAlignment: { Right: 1 },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
const extension = require('../packages/vscode/dist/extension.cjs');
Module._load = originalLoad;
extension.activate({ subscriptions: [], workspaceState: { get: key => state.get(key), update: async (key, value) => state.set(key, value) }, secrets: { get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value), delete: async key => secrets.delete(key) } });

async function run() {
  const configPath = path.join(project, 'easy-deploy.json');
  const original = await readFile(configPath, 'utf8');
  const upload = commands.get('easyDeploy.upload');
  const download = commands.get('easyDeploy.download');
  try {
    const protectedFile = path.join(project, 'vscode-protected.txt');
    const protectedRemote = path.join(remote, 'vscode-protected.txt');
    await writeFile(protectedFile, 'local');
    const config = JSON.parse(original);
    config.targets.local.protected = true;
    await writeFile(configPath, JSON.stringify(config));
    answer = undefined;
    await upload(uri(protectedFile));
    assert.equal(existsSync(protectedRemote), false, '取消确认后仍上传了文件');
    answer = '确认上传';
    await upload(uri(protectedFile));
    assert.equal(await readFile(protectedRemote, 'utf8'), 'local');

    await writeFile(protectedRemote, 'remote');
    answer = undefined;
    await download(uri(protectedFile));
    assert.equal(await readFile(protectedFile, 'utf8'), 'local', '取消覆盖后仍修改了本地文件');
    answer = '确认覆盖';
    await download(uri(protectedFile));
    assert.equal(await readFile(protectedFile, 'utf8'), 'remote');

    const localDir = path.join(project, 'vscode-cancel');
    await mkdir(localDir);
    await writeFile(path.join(localDir, 'a.txt'), 'a');
    await writeFile(path.join(localDir, 'b.txt'), 'b');
    answer = '确认上传';
    cancelAfterFirst = true;
    await upload(uri(localDir));
    assert.equal(await readFile(path.join(remote, 'vscode-cancel/a.txt'), 'utf8'), 'a');
    assert.equal(existsSync(path.join(remote, 'vscode-cancel/b.txt')), false, '取消后继续上传了下一文件');

    const alternateRemote = path.join(remote, 'vscode-alternate');
    await mkdir(alternateRemote);
    config.targets.second = { ...config.targets.local, remote: alternateRemote, protected: false };
    await writeFile(configPath, JSON.stringify(config));
    picked = 'second';
    await commands.get('easyDeploy.selectTarget')();
    const targetFile = path.join(project, 'vscode-target.txt');
    await writeFile(targetFile, 'second');
    await upload(uri(targetFile));
    assert.equal(await readFile(path.join(alternateRemote, 'vscode-target.txt'), 'utf8'), 'second');
    assert.equal(existsSync(path.join(remote, 'vscode-target.txt')), false, 'Target 切换后仍上传到了原目录');
    config.targets.second.uploadOnSave = true;
    await writeFile(configPath, JSON.stringify(config));
    const autoFile = path.join(project, 'vscode-auto.txt');
    await writeFile(autoFile, 'automatic');
    await savedDocument({ uri: { ...uri(autoFile), scheme: 'file' }, version: 1 });
    assert.equal(await readFile(path.join(alternateRemote, 'vscode-auto.txt'), 'utf8'), 'automatic');
    config.targets.second.auth = { type: 'password', passwordEnv: 'ED_TEST_PASSWORD' };
    await writeFile(configPath, JSON.stringify(config));
    input = 'test-secret';
    await commands.get('easyDeploy.setPassword')();
    assert.equal(secrets.size, 1);
    await commands.get('easyDeploy.forgetPassword')();
    assert.equal(secrets.size, 0);
    assert.deepEqual(errors, []);
    console.log('VS Code 确认、取消和 Target 切换测试通过');
  } finally {
    await writeFile(configPath, original);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
