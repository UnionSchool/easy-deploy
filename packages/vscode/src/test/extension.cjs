const assert = require('node:assert/strict');
const { mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
  const folders = vscode.workspace.workspaceFolders;
  assert.equal(folders?.length, Number(process.env.ED_TEST_WORKSPACES || 1), '测试工作区数量不符');
  const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'easy-deploy-vscode');
  assert.ok(extension, 'Easy Deploy 扩展未加载');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['upload', 'download', 'selectTarget', 'openConfig']) {
    assert.ok(commands.includes(`easyDeploy.${name}`), `缺少 ${name} 命令`);
  }
  const menus = extension.packageJSON.contributes.menus;
  assert.ok(menus['explorer/context']?.length && menus['editor/context']?.length, '缺少右键菜单');
  async function roundTrip(folder, remote, index) {
    assert.ok(remote, '缺少远端测试目录');
    const local = path.join(folder.uri.fsPath, 'vscode-smoke');
    await mkdir(local);
    await writeFile(path.join(local, 'file.txt'), `from workspace ${index}`);
    await vscode.commands.executeCommand('easyDeploy.upload', vscode.Uri.file(local));
    assert.equal(await readFile(path.join(remote, 'vscode-smoke/file.txt'), 'utf8'), `from workspace ${index}`);
    await rm(local, { recursive: true });
    await vscode.commands.executeCommand('easyDeploy.download', vscode.Uri.file(local));
    assert.equal(await readFile(path.join(local, 'file.txt'), 'utf8'), `from workspace ${index}`);
  }
  await roundTrip(folders[0], process.env.ED_TEST_REMOTE, 0);
  const edited = path.join(folders[0].uri.fsPath, 'vscode-unsaved.txt');
  await writeFile(edited, 'before');
  const document = await vscode.workspace.openTextDocument(edited);
  await vscode.window.showTextDocument(document);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), 'after');
  assert.ok(await vscode.workspace.applyEdit(edit));
  assert.equal(document.isDirty, true);
  await vscode.commands.executeCommand('easyDeploy.upload');
  assert.equal(await readFile(path.join(process.env.ED_TEST_REMOTE, 'vscode-unsaved.txt'), 'utf8'), 'after');
  assert.equal(document.isDirty, false);
  if (folders.length === 2) await roundTrip(folders[1], process.env.ED_TEST_REMOTE_SECOND, 1);
  await writeFile(process.env.ED_TEST_RESULT, 'passed');
}

exports.run = async () => {
  try { await run(); }
  catch (error) {
    await writeFile(process.env.ED_TEST_RESULT, error.stack || String(error));
    throw error;
  }
};
