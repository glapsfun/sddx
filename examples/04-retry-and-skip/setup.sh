#!/bin/sh
# Scratch git repo + a local ./sddx shim so this example runs against the
# current checkout without a global install. $1 (optional) is the target
# directory; defaults to a gitignored .sandbox/ next to this script for a
# convenient local run. The harness always passes an external tmpdir.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET="${1:-$SCRIPT_DIR/.sandbox}"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cat > "$TARGET/sddx" <<SHIM
#!/bin/sh
exec "$REPO_ROOT/bin/sddx-run" "$REPO_ROOT/dist/cli.mjs" "\$@"
SHIM
chmod +x "$TARGET/sddx"
cd "$TARGET"
git init -q -b main
git config user.email "example@sddx.invalid"
git config user.name "sddx example"
git config commit.gpgsign false
git commit -q --allow-empty -m init
echo "$TARGET"
