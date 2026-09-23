#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
test_dir=$(mktemp -d)
server_pid=
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  if [[ "${ED_TEST_VSCODE:-}" == 1 ]]; then
    node -e 'const {execFileSync}=require("node:child_process"); for(const line of execFileSync("ps",["-axo","pid=,command="],{encoding:"utf8"}).split("\n")){const match=/^\s*(\d+)\s+(.*)$/.exec(line); if(match && match[2].startsWith("/Applications/Visual Studio Code.app/Contents/MacOS/Code --extensionDevelopmentPath=") && match[2].includes(process.argv[1])) process.kill(Number(match[1]),"SIGTERM");}' "$test_dir/vscode-user" 2>/dev/null || true
  fi
  rm -rf "$test_dir"
}
trap cleanup EXIT

port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
mkdir -p "$test_dir/project" "$test_dir/remote"
ssh-keygen -q -t ed25519 -N '' -f "$test_dir/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$test_dir/user_key"
cp "$test_dir/user_key.pub" "$test_dir/authorized_keys"
printf '[127.0.0.1]:%s %s\n' "$port" "$(cat "$test_dir/host_key.pub")" > "$test_dir/known_hosts"
cat > "$test_dir/sshd_config" <<EOF
Port $port
ListenAddress 127.0.0.1
HostKey $test_dir/host_key
AuthorizedKeysFile $test_dir/authorized_keys
PidFile $test_dir/sshd.pid
Subsystem sftp internal-sftp
PasswordAuthentication no
PubkeyAuthentication yes
UsePAM no
StrictModes no
LogLevel ERROR
EOF
"$(command -v sshd || printf /usr/sbin/sshd)" -D -e -f "$test_dir/sshd_config" > "$test_dir/sshd.log" 2>&1 &
server_pid=$!
sleep 1
if ! kill -0 "$server_pid" 2>/dev/null; then cat "$test_dir/sshd.log"; exit 1; fi

cat > "$test_dir/project/easy-deploy.json" <<EOF
{
  "version": 1,
  "default": "local",
  "targets": {
    "local": {
      "driver": "sftp", "host": "127.0.0.1", "port": $port,
      "username": "$(whoami)", "local": ".", "remote": "$test_dir/remote",
      "auth": { "type": "private-key", "privateKeyPath": "$test_dir/user_key" }
    }
  }
}
EOF
printf 'sftp smoke test\n' > "$test_dir/project/hello.txt"
cd "$test_dir/project"
export ED_KNOWN_HOSTS="$test_dir/known_hosts"
node "$repo_dir/packages/cli/dist/index.js" up hello.txt
test "$(cat "$test_dir/remote/hello.txt")" = 'sftp smoke test'
rm hello.txt
node "$repo_dir/packages/cli/dist/index.js" down hello.txt
test "$(cat hello.txt)" = 'sftp smoke test'
printf 'remote update\n' > "$test_dir/remote/hello.txt"
if node "$repo_dir/packages/cli/dist/index.js" down hello.txt >/dev/null 2>&1; then
  echo 'download overwrote a file without confirmation' >&2
  exit 1
fi
test "$(cat hello.txt)" = 'sftp smoke test'
node "$repo_dir/packages/cli/dist/index.js" down hello.txt -t local --approved-overwrite >/dev/null
test "$(cat hello.txt)" = 'remote update'
printf 'sftp smoke test\n' > hello.txt
node "$repo_dir/packages/cli/dist/index.js" up hello.txt >/dev/null
node "$repo_dir/packages/cli/dist/index.js" doctor --check-write --json > "$test_dir/doctor.json"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["connected"] and d["remoteExists"] and d["writable"]' "$test_dir/doctor.json"
if find "$test_dir/remote" -name '.ed-check-*' | grep -q .; then
  echo 'doctor left a test file behind' >&2
  exit 1
fi
head -c 70000 /dev/urandom > binary.dat
node "$repo_dir/packages/cli/dist/index.js" up binary.dat >/dev/null
cmp binary.dat "$test_dir/remote/binary.dat"
rm binary.dat
node "$repo_dir/packages/cli/dist/index.js" down binary.dat >/dev/null
cmp binary.dat "$test_dir/remote/binary.dat"
mkdir -p sub
printf 'unicode\n' > 'sub/中文 文件.txt'
node "$repo_dir/packages/cli/dist/index.js" up sub
test "$(cat "$test_dir/remote/sub/中文 文件.txt")" = 'unicode'
node "$repo_dir/packages/cli/dist/index.js" targets --json | python3 -c 'import json,sys; raw=sys.stdin.read(); assert len(raw.strip().splitlines()) == 1; d=json.loads(raw); assert d["apiVersion"] == 1 and d["default"] == "local" and d["targets"] == ["local"]'
node "$repo_dir/packages/cli/dist/index.js" status --json | python3 -c 'import json,sys; raw=sys.stdin.read(); assert len(raw.strip().splitlines()) == 1; d=json.loads(raw); assert d["apiVersion"] == 1 and d["local"] == "." and d["remote"] and d["protected"] is False'
node "$repo_dir/packages/cli/dist/index.js" up 'sub/中文 文件.txt' --dry-run --json | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["dryRun"] and len(d["items"]) == 1 and d["items"][0]["relative"] == "sub/中文 文件.txt"'
node "$repo_dir/packages/cli/dist/index.js" down 'sub/中文 文件.txt' --dry-run --json | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["dryRun"] and len(d["items"]) == 1 and d["items"][0]["local"].endswith("sub/中文 文件.txt")'
rm -rf sub
node "$repo_dir/packages/cli/dist/index.js" down sub
test "$(cat 'sub/中文 文件.txt')" = 'unicode'
mkdir empty
node "$repo_dir/packages/cli/dist/index.js" up empty
test -d "$test_dir/remote/empty"
rmdir empty
node "$repo_dir/packages/cli/dist/index.js" down empty
test -d empty
node "$repo_dir/tests/vscode-controls.cjs" "$test_dir/project" "$test_dir/remote"
if [[ "${ED_TEST_VSCODE:-}" == 1 ]]; then
  export ED_TEST_REMOTE="$test_dir/remote"
  export ED_TEST_RESULT="$test_dir/vscode-result"
  workspace="$test_dir/project"
  if [[ "${ED_TEST_VSCODE_MULTI:-}" == 1 ]]; then
    mkdir -p "$test_dir/project-second" "$test_dir/remote-second"
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["targets"]["local"]["remote"]=sys.argv[3]; json.dump(d,open(sys.argv[2],"w"))' "$test_dir/project/easy-deploy.json" "$test_dir/project-second/easy-deploy.json" "$test_dir/remote-second"
    python3 -c 'import json,sys; json.dump({"folders":[{"path":sys.argv[1]},{"path":sys.argv[2]}]},open(sys.argv[3],"w"))' "$test_dir/project" "$test_dir/project-second" "$test_dir/test.code-workspace"
    workspace="$test_dir/test.code-workspace"
    export ED_TEST_REMOTE_SECOND="$test_dir/remote-second" ED_TEST_WORKSPACES=2
  fi
  code --extensionDevelopmentPath="$repo_dir/packages/vscode" \
    --extensionTestsPath="$repo_dir/packages/vscode/src/test/extension.cjs" \
    --user-data-dir="$test_dir/vscode-user" \
    --extensions-dir="$test_dir/vscode-extensions" \
    --disable-workspace-trust --skip-welcome --skip-release-notes \
    --new-window "$workspace" > "$test_dir/code.log" 2>&1
  for ((attempt=0; attempt<360; attempt++)); do
    [[ -f "$ED_TEST_RESULT" ]] && break
    sleep 0.25
  done
  result=$(cat "$ED_TEST_RESULT" 2>/dev/null || true)
  if [[ "$result" != passed ]]; then
    echo "VS Code 扩展测试失败：${result:-未启动}" >&2
    tail -30 "$test_dir/code.log" >&2
    rg -n 'extensionTests|vscode-extension|Error|EACCES|Easy Deploy' "$test_dir/vscode-user/logs" 2>/dev/null | tail -35 >&2 || true
    exit 1
  fi
fi
ln -s hello.txt "$test_dir/remote/linked.txt"
printf 'must not overwrite target\n' > linked.txt
if node "$repo_dir/packages/cli/dist/index.js" up linked.txt >/dev/null 2>&1; then
  echo 'remote symlink was overwritten' >&2
  exit 1
fi
test "$(cat "$test_dir/remote/hello.txt")" = 'sftp smoke test'
if node "$repo_dir/packages/cli/dist/index.js" down linked.txt >/dev/null 2>&1; then
  echo 'remote symlink was downloaded' >&2
  exit 1
fi
if ED_KNOWN_HOSTS="$test_dir/missing_hosts" node "$repo_dir/packages/cli/dist/index.js" doctor >/dev/null 2>&1; then
  echo 'unknown SSH host was accepted' >&2
  exit 1
fi
printf 'permission check\n' > permission.txt
chmod 500 "$test_dir/remote"
permission_failed=0
if node "$repo_dir/packages/cli/dist/index.js" up permission.txt >/dev/null 2>&1; then permission_failed=1; fi
chmod 700 "$test_dir/remote"
if [[ "$permission_failed" == 1 || -e "$test_dir/remote/permission.txt" ]]; then
  echo 'SFTP upload ignored remote write permissions' >&2
  exit 1
fi
python3 -c 'import json; p="easy-deploy.json"; d=json.load(open(p)); d["targets"]["local"]["protected"]=True; open(p,"w").write(json.dumps(d))'
node "$repo_dir/packages/cli/dist/index.js" up hello.txt --dry-run >/dev/null
if node "$repo_dir/packages/cli/dist/index.js" up hello.txt >/dev/null 2>&1; then
  echo 'protected target accepted a non-interactive write' >&2
  exit 1
fi
echo 'SFTP smoke test passed'
