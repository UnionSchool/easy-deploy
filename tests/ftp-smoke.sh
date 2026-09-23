#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
test_dir=$(mktemp -d)
server_pid=
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  rm -rf "$test_dir"
}
trap cleanup EXIT

port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
export ED_TEST_FTP_PASSWORD
ED_TEST_FTP_PASSWORD=$(python3 -c 'import secrets; print(secrets.token_hex(12))')
mkdir -p "$test_dir/project" "$test_dir/remote/project"
python3 "$repo_dir/tests/ftp-server.py" "$test_dir/remote" "$port" > "$test_dir/ftp.log" 2>&1 &
server_pid=$!
sleep 1
if ! kill -0 "$server_pid" 2>/dev/null; then cat "$test_dir/ftp.log"; exit 1; fi

cat > "$test_dir/project/easy-deploy.json" <<EOF
{
  "version": 1,
  "default": "local",
  "targets": {
    "local": {
      "driver": "ftp", "host": "127.0.0.1", "port": $port,
      "username": "tester", "local": ".", "remote": "/project",
      "auth": { "type": "password", "passwordEnv": "ED_TEST_FTP_PASSWORD" }
    }
  }
}
EOF
printf 'ftp smoke test\n' > "$test_dir/project/hello.txt"
cd "$test_dir/project"
node "$repo_dir/packages/cli/dist/index.js" up hello.txt
test "$(cat "$test_dir/remote/project/hello.txt")" = 'ftp smoke test'
rm hello.txt
node "$repo_dir/packages/cli/dist/index.js" down hello.txt
test "$(cat hello.txt)" = 'ftp smoke test'
printf 'remote update\n' > "$test_dir/remote/project/hello.txt"
if node "$repo_dir/packages/cli/dist/index.js" down hello.txt >/dev/null 2>&1; then
  echo 'download overwrote a file without confirmation' >&2
  exit 1
fi
test "$(cat hello.txt)" = 'ftp smoke test'
node "$repo_dir/packages/cli/dist/index.js" down hello.txt -t local --approved-overwrite >/dev/null
test "$(cat hello.txt)" = 'remote update'
printf 'ftp smoke test\n' > hello.txt
node "$repo_dir/packages/cli/dist/index.js" up hello.txt >/dev/null
failure=$(ED_TEST_FTP_PASSWORD=DO_NOT_PRINT_THIS_PASSWORD node "$repo_dir/packages/cli/dist/index.js" doctor --json 2>&1) && {
  echo 'FTP accepted an invalid password' >&2
  exit 1
}
if [[ "$failure" == *DO_NOT_PRINT_THIS_PASSWORD* ]]; then
  echo 'FTP error exposed the password' >&2
  exit 1
fi
printf '%s' "$failure" | python3 -c 'import json,sys; raw=sys.stdin.read(); assert len(raw.splitlines()) == 1; d=json.loads(raw); assert d["error"] == "auth" and d["message"]'
mkdir -p sub
printf 'unicode\n' > 'sub/中文 文件.txt'
node "$repo_dir/packages/cli/dist/index.js" up sub
test "$(cat "$test_dir/remote/project/sub/中文 文件.txt")" = 'unicode'
node "$repo_dir/packages/cli/dist/index.js" ls sub --json | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["apiVersion"] == 1 and any(x["name"] == "中文 文件.txt" for x in d["entries"])'
rm -rf sub
node "$repo_dir/packages/cli/dist/index.js" down sub
test "$(cat 'sub/中文 文件.txt')" = 'unicode'
mkdir empty
node "$repo_dir/packages/cli/dist/index.js" up empty
test -d "$test_dir/remote/project/empty"
rmdir empty
node "$repo_dir/packages/cli/dist/index.js" down empty
test -d empty
printf 'remote content\n' > "$test_dir/remote/project/drop.txt"
printf 'keep local\n' > drop.txt
if node "$repo_dir/packages/cli/dist/index.js" down drop.txt -t local --approved-overwrite >/dev/null 2>&1; then
  echo 'interrupted download was reported as successful' >&2
  exit 1
fi
test "$(cat drop.txt)" = 'keep local'
if find "$test_dir/project" -name 'drop.txt.ed-*.tmp' | grep -q .; then
  echo 'interrupted download left a temporary file' >&2
  exit 1
fi
printf 'keep remote\n' > "$test_dir/remote/project/protected.txt"
ln -s protected.txt "$test_dir/remote/project/link.txt"
printf 'overwrite attempt\n' > link.txt
if node "$repo_dir/packages/cli/dist/index.js" up link.txt >/dev/null 2>&1; then
  echo 'FTP upload followed a remote symbolic link' >&2
  exit 1
fi
test "$(cat "$test_dir/remote/project/protected.txt")" = 'keep remote'
rm link.txt
if node "$repo_dir/packages/cli/dist/index.js" down link.txt >/dev/null 2>&1; then
  echo 'FTP download followed a remote symbolic link' >&2
  exit 1
fi
mkdir "$test_dir/remote/project/real-dir" shortcut
ln -s real-dir "$test_dir/remote/project/shortcut"
printf 'parent link attempt\n' > shortcut/new.txt
if node "$repo_dir/packages/cli/dist/index.js" up shortcut/new.txt >/dev/null 2>&1; then
  echo 'FTP upload followed a symbolic link in the remote path' >&2
  exit 1
fi
test ! -e "$test_dir/remote/project/real-dir/new.txt"
printf 'keep remote\n' > "$test_dir/remote/project/real-dir/inside.txt"
if node "$repo_dir/packages/cli/dist/index.js" down shortcut/inside.txt >/dev/null 2>&1; then
  echo 'FTP download followed a symbolic link in the remote path' >&2
  exit 1
fi
test ! -e shortcut/inside.txt
echo 'FTP smoke test passed'
