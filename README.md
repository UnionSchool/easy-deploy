# Easy Deploy

Easy Deploy 是一个尽量简单的项目文件部署工具，提供命令行、VS Code 扩展和 JetBrains 插件。配置文件是 JSON；运行时没有 npm 第三方依赖。SFTP 文件传输由项目代码实现，连接和主机身份校验使用系统 OpenSSH；FTP 客户端使用 Node.js 内置的 `net`。

项目目前仍在开发。已在 macOS 和 Linux 验证主要传输流程；GitHub CI 已在 macOS、Linux、Windows 通过类型检查、测试、构建和 CLI 冒烟测试。Windows 的真实服务器传输仍待验收。

## 环境要求

- Node.js 24 或更新的受支持版本。
- SFTP：系统提供 `ssh` 命令（OpenSSH），并已配置可信的主机密钥。
- FTP：无需 `ssh`，但协议本身为明文，仅适合可信网络中的旧服务器。
- JetBrains 插件：除插件外，还需安装命令行工具，并让 IDE 进程的 `PATH` 能找到 `easy-deploy`。

## 安装与卸载

通过 npm 全局安装：

```bash
npm install -g @unionschool/easy-deploy
easy-deploy --version
```

`ed` 是同一个命令的简写。macOS 自带 `/bin/ed` 行编辑器；全局安装后，输入 `ed` 会按 `PATH` 顺序选择其中一个程序，不会修改系统文件。建议用 `easy-deploy --version` 检查安装；需要系统行编辑器时直接运行 `/bin/ed`。

npm 包名带 `@unionschool`，全局安装后的命令仍是 `easy-deploy` 和 `ed`。

也可从 [GitHub](https://github.com/UnionSchool/easy-deploy) 或 [Gitee](https://gitee.com/UnionSchool/easy-deploy) 获取源码，并生成本地安装包：

```bash
git clone https://github.com/UnionSchool/easy-deploy.git
cd easy-deploy
pnpm install --frozen-lockfile
pnpm build
pnpm --dir packages/cli pack --pack-destination /tmp
npm install -g /tmp/unionschool-easy-deploy-0.3.0.tgz
easy-deploy --version
```

升级可运行 `ed update`（或 `easy-deploy update`），也可用 `npm update -g @unionschool/easy-deploy`；完成后运行 `ed --version` 核对。卸载运行 `npm uninstall -g @unionschool/easy-deploy`。JetBrains 用户升级 CLI 后重新打开 IDE，让插件读取新的 `PATH` 和命令版本。

## 五分钟开始：SFTP

在项目根目录运行 `easy-deploy init`，它会创建 `easy-deploy.json`。编辑为实际 Target：

```json
{
  "version": 1,
  "default": "dev",
  "targets": {
    "dev": {
      "driver": "sftp",
      "host": "dev.example.com",
      "username": "deploy",
      "local": ".",
      "remote": "/srv/project",
      "auth": { "type": "ssh-config" },
      "ignore": ["node_modules", "vendor"]
    }
  }
}
```

`local` 相对于配置文件所在目录，`remote` 是服务器上的绝对路径。`host` 可以是 SSH config 中的 Host 别名。首次连接前，请先用系统 `ssh` 核对并信任服务器主机指纹；工具不会关闭主机身份校验。

先检查连接和计划，再执行传输：

```bash
easy-deploy targets
easy-deploy doctor
easy-deploy up src --dry-run
easy-deploy up src
easy-deploy down src
```

上传、下载都支持文件和目录，包含空目录、空格及中文文件名。下载会在覆盖已有本地文件前要求确认。

## 配置 Target

一个配置可放多个 Target，用 `-t` 选择；不指定时使用 `default`。例如 `easy-deploy up src -t test --dry-run`。

| 字段 | 说明 |
| --- | --- |
| `driver` | `sftp` 或 `ftp`。 |
| `host`、`port`、`username` | 服务器地址、可选端口、可选用户名。SFTP 默认端口由 SSH/OpenSSH 处理；FTP 默认 21。 |
| `local`、`remote` | 项目中的相对目录、服务器上的绝对目录；不允许 `..` 越界。 |
| `auth` | SFTP 支持 `ssh-config`、`private-key`、`password`；FTP 使用 `password`。 |
| `ignore` | 额外忽略规则，与配置根目录的 `.gitignore` 合并。 |
| `protected` | 设为 `true` 时，上传或写权限检查前要求确认。 |
| `uploadOnSave` | VS Code 保存文件后自动上传；默认关闭，不能用于 `protected: true`。 |

SFTP 使用 `ssh-config` 时，可复用 SSH config、SSH Agent 和已配置的密钥。`private-key` 认证可在 `auth.privateKeyPath` 指定私钥路径。密码认证使用 `auth: { "type": "password", "passwordEnv": "ED_SFTP_PASSWORD" }`；工具从同名环境变量读取密码，不把密码写进 JSON。

FTP 示例：

```json
{
  "driver": "ftp",
  "host": "ftp.example.com",
  "port": 21,
  "username": "deploy",
  "local": ".",
  "remote": "/public_html",
  "auth": { "type": "password", "passwordEnv": "ED_FTP_PASSWORD" }
}
```

把这个对象放入 `targets`，并在运行工具的环境中设置 `ED_FTP_PASSWORD`。不要把密码、私钥或包含它们的 `.env` 文件提交到 Git。FTP 使用被动模式（EPSV，必要时回退 PASV）；远端符号链接检查要求服务器提供可解析的 Unix 格式 `LIST`，无法检查时传输会失败。

macOS 的 zsh 中，CLI 可临时运行 `export ED_SFTP_PASSWORD='你的密码'`，同一个终端窗口内再运行 `easy-deploy ...`。FTP 则改用 `ED_FTP_PASSWORD`。从 Dock 启动的 VS Code/PhpStorm 通常不会继承终端的环境变量；扩展或插件首次连接时会弹出密码输入框并交由系统凭据存储，之后无需每次从终端启动。不要把密码写入 `~/.zshrc`、`easy-deploy.json` 或 Git 仓库。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `easy-deploy init` | 在当前目录创建 JSON 配置，不覆盖已有文件。 |
| `easy-deploy targets` | 查看 Target 列表和默认 Target。 |
| `easy-deploy status [-t name]` | 查看当前 Target、路径、保护状态和 Git 变更数。 |
| `easy-deploy doctor [-t name]` | 测试连接和远端根目录是否存在。 |
| `easy-deploy doctor --check-write` | 创建并删除远端测试文件，检查写权限。 |
| `ed update` | 更新全局安装的 Easy Deploy CLI。 |
| `easy-deploy up <path> [--dry-run]` | 上传文件或目录；Dry Run 只列出计划。 |
| `easy-deploy up --changed` | 上传 Git 变更文件；已删除文件只报告，不删除远端文件。 |
| `easy-deploy down <path> [--dry-run]` | 下载远端文件或目录；覆盖前确认。 |
| `easy-deploy ls [path] --json` | 列出远端根目录或子目录，供 JetBrains 远程面板使用。 |

`<path>` 相对于 Target 的 `local`/`remote` 根目录。所有命令都可加 `-t name` 选择 Target；`--json` 输出单行 JSON，供脚本和 JetBrains 插件使用。无交互终端时，受保护上传和本地覆盖会被拒绝。目录传输不跟随符号链接，默认禁止上传 `.git`、`.env` 和常见私钥文件。当前只读取配置根目录的 `.gitignore`，不读取子目录的 `.gitignore`。

## VS Code 扩展

扩展会打包传输 Core，使用时不要求全局安装 CLI。本地构建与安装：

```bash
pnpm install --frozen-lockfile
pnpm build
cd packages/vscode
npx @vscode/vsce package --out easy-deploy.vsix
```

在 VS Code 扩展页面选择 **Install from VSIX**，安装生成的文件。打开含 `easy-deploy.json` 的项目后，可在文件树或编辑器右键上传、下载文件和目录；菜单中 Upload 位于 Download 上方。命令面板提供 **Initialize**、**Upload Changed Files**、**Select Target**、**Test Connection**、**Set Password**、**Forget Password** 和 **Open Configuration**。首次连接密码目标时输入一次密码，重开 VS Code 后会从系统凭据读取。多工作区会按文件所属工作区选择配置，状态栏显示当前 Target。

macOS 按 `⌃⌘U` 上传、`⌃⌘G` 下载；Windows/Linux 按 `Ctrl+Alt+U`、`Ctrl+Alt+G`。编辑器中作用于当前文件，文件树中作用于选中的单个文件或目录。手动上传会先保存相关未保存的文件，保存失败则取消。可在 VS Code 键盘快捷方式设置中修改。需要保存时自动上传，在目标中设置 `"uploadOnSave": true`；仅作用于非受保护目标，不上传配置文件本身，上传成功会显示文件名和 Target。

## JetBrains 插件

先安装 `easy-deploy` CLI，再构建插件：

```bash
cd plugins/jetbrains
./gradlew buildPlugin
```

插件从 PhpStorm 2023.3.8 起支持。在 IDE 的 **Settings → Plugins → Install Plugin from Disk** 中选择 `build/distributions/` 下的 ZIP。项目文件右键菜单包含 Upload、Download 和 Select Target；右侧 **Easy Deploy** 面板按需展开远程目录，并可对选中项上传、下载。插件通过 `easy-deploy --json` 调用 CLI，IDE 进程的 `PATH` 必须能找到该命令。密码首次输入后由 IDE 密码库保存；每次传输都重新连接，避免复用空闲 FTP 连接。受保护目标和覆盖本地文件会弹出确认框。已在 PhpStorm 2023.3.8 SDK 构建；IDE 内完整交互仍待验收。

## 开发与测试

开发需 pnpm 8；JetBrains 插件还需 JDK 17 和项目自带的 Gradle Wrapper。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node tests/cli-smoke.mjs
tests/sftp-smoke.sh
```

本地 FTP 集成测试仅测试环境需要 `pyftpdlib`：

```bash
python3 -m pip install --target /tmp/easy-deploy-pyftpdlib pyftpdlib
PYTHONPATH=/tmp/easy-deploy-pyftpdlib tests/ftp-smoke.sh
```

已安装 VS Code 并配置 `code` 命令时，可运行 `ED_TEST_VSCODE=1 tests/sftp-smoke.sh`；双工作区测试增加 `ED_TEST_VSCODE_MULTI=1`。[GitHub Actions](https://github.com/UnionSchool/easy-deploy/actions) 已在 macOS、Linux、Windows 通过类型检查、测试、构建和 CLI 冒烟测试；macOS 还通过本地 SFTP 冒烟测试，JetBrains 插件通过构建和结构检查。

## npm 发布

GitHub 的 `publish.yml` 只在正式 `vX.Y.Z` 标签推送时发布 CLI 包；开发进度标签 `progress/*` 不触发发布。工作流先验证版本、安装依赖并运行测试，再通过 npm Trusted Publishing（OIDC）发布，无需把 npm Token 放进仓库。

首次发布需要 npm 账号；随后为 `@unionschool/easy-deploy` 包配置 Trusted Publisher：GitHub 用户/组织 `UnionSchool`、仓库 `easy-deploy`、工作流文件 `publish.yml`，允许 `npm publish`。后续发布需核对版本、在公开仓库提交上打 `vX.Y.Z` 标签并推送。

## 隐私与常见问题

本仓库的 `docs/`、`easy-deploy.json`、`.env*`、私钥和证书文件被 Git 忽略。自己的项目也应根据需要忽略部署配置；密码只放环境变量或系统凭据存储。发布前用 `npm pack --dry-run` 检查包内容。

| 现象 | 处理方法 |
| --- | --- |
| `ed` 显示系统编辑器或找不到 CLI | 使用 `easy-deploy --version`；检查 npm 全局安装目录是否在 `PATH`。 |
| JetBrains 找不到 CLI | 在 IDE 的运行环境中检查 `easy-deploy --version`，必要时重启 IDE。 |
| SFTP 主机身份或认证失败 | 用系统 `ssh` 核对主机指纹、SSH config、Agent、私钥和密码环境变量。 |
| FTP 登录或目录列表失败 | 检查账号、端口、被动模式端口及服务器是否提供 Unix 格式 `LIST`。 |
| 远端路径不存在或无写权限 | 检查 `remote`；先运行 `doctor`，确认目标后运行 `doctor --check-write`。 |
| 上传或下载被拒绝 | 检查 Target 的 `protected`、本地覆盖确认和非交互环境限制。 |
| 旧 YAML 配置无法读取 | 配置已改用 `easy-deploy.json`，按上面的示例手动转换。 |

## 许可证

[MIT](LICENSE) © 2026 UnionSchool。
