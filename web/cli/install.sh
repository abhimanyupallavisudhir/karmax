#!/bin/sh
# Installs the tavya CLI:  curl -fsSL https://tavya.io/cli/install.sh | sh
# A single executable from the CLI's GitHub release, checked against that
# release's SHA256SUMS. With Node 22 you can instead run `npm install -g tavya`.
# TAVYA_VERSION=1.2.3 pins a version; TAVYA_INSTALL_DIR overrides ~/.local/bin.
set -eu
repo=abhimanyupallavisudhir/karmax
os=$(uname -s); arch=$(uname -m)
case "$os" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "tavya: no build for $os; use: npm install -g tavya" >&2; exit 1 ;; esac
case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "tavya: no build for $arch; use: npm install -g tavya" >&2; exit 1 ;; esac
version=${TAVYA_VERSION:-}
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/$repo/releases?per_page=100" | grep -o '"tag_name": *"cli-v[^"]*"' | head -n 1 | sed 's/.*cli-v//; s/"$//')
fi
[ -n "$version" ] || { echo "tavya: could not find a release" >&2; exit 1; }
name="tavya-$os-$arch"
base="https://github.com/$repo/releases/download/cli-v$version"
dir=${TAVYA_INSTALL_DIR:-$HOME/.local/bin}
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
echo "Downloading tavya $version ($os-$arch)…" >&2
curl -fSL --progress-bar "$base/$name" -o "$tmp"
expected=$(curl -fsSL "$base/SHA256SUMS" | awk -v f="$name" '$2 == f { print $1 }')
actual=$( (sha256sum "$tmp" 2>/dev/null || shasum -a 256 "$tmp") | cut -d' ' -f1)
[ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "tavya: the download does not match its checksum" >&2; exit 1; }
mkdir -p "$dir"
chmod +x "$tmp"
mv "$tmp" "$dir/tavya"
trap - EXIT
echo "Installed tavya $version to $dir/tavya" >&2
case ":$PATH:" in *":$dir:"*) ;; *) echo "Add $dir to your PATH, e.g.: export PATH=\"$dir:\$PATH\"" >&2 ;; esac
echo "Next: tavya login" >&2
