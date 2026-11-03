#!/usr/bin/env bash
#
# Alaye OS - POSIX installer.
#
# Installs an isolated Node + Python runtime for the Alaye OS desktop shell and
# Hermes gateway daemon into ~/.alaye-os, registers systemd user services, and
# drops desktop/application shortcuts.
#
# Usage:
#   curl -fsSL https://get.alaye.os/install.sh | bash
#   ./install.sh [--prefix DIR] [--version TAG] [--no-service] [--no-desktop]
#
set -euo pipefail

APP_NAME="Alaye OS"
APP_SLUG="alaye-os"
INSTALL_ROOT="${ALAYE_INSTALL_ROOT:-$HOME/.alaye-os}"
REPO_URL="${ALAYE_REPO_URL:-https://github.com/alaye-systems/alaye-os.git}"
APP_VERSION="${ALAYE_VERSION:-latest}"
HERMES_REPO="${ALAYE_HERMES_REPO:-https://github.com/nousresearch/hermes-agent.git}"
HERMES_REF="${ALAYE_HERMES_REF:-main}"
NODE_MIN_MAJOR=20
PY_MIN_MAJOR=3
PY_MIN_MINOR=10
BIN_DIR="$INSTALL_ROOT/bin"
LOG_FILE="$INSTALL_ROOT/install.log"

WITH_SERVICE=1
WITH_DESKTOP=1

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) INSTALL_ROOT="$2"; BIN_DIR="$INSTALL_ROOT/bin"; LOG_FILE="$INSTALL_ROOT/install.log"; shift 2 ;;
    --version) APP_VERSION="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --no-service) WITH_SERVICE=0; shift ;;
    --no-desktop) WITH_DESKTOP=0; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# Engine paths must be derived after --prefix has had a chance to move the root.
ENGINE_DIR="$INSTALL_ROOT/engine"
HERMES_DIR="$ENGINE_DIR/hermes-agent"
VENV_DIR="$ENGINE_DIR/venv"
HERMES_BIN="$VENV_DIR/bin/hermes"
DIST_DIR="$INSTALL_ROOT/release"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'
else
  C_RESET=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""
fi

_ts() { date '+%Y-%m-%dT%H:%M:%S'; }
info()  { printf '%s %s[info]%s %s\n'  "$(_ts)" "$C_BLUE"   "$C_RESET" "$*"; }
ok()    { printf '%s %s[ ok ]%s %s\n'  "$(_ts)" "$C_GREEN"  "$C_RESET" "$*"; }
warn()  { printf '%s %s[warn]%s %s\n'  "$(_ts)" "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()   { printf '%s %s[fail]%s %s\n'  "$(_ts)" "$C_RED"    "$C_RESET" "$*" >&2; exit 1; }

trap 'die "installation aborted at line $LINENO"' ERR

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------
detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"
  case "$OS" in
    Linux)  PLATFORM="linux" ;;
    Darwin) PLATFORM="darwin" ;;
    *) die "unsupported platform: $OS (Windows users should run install.ps1)" ;;
  esac
  case "$ARCH" in
    x86_64|amd64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) die "unsupported architecture: $ARCH" ;;
  esac
  info "platform detected: $PLATFORM/$ARCH"
}

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

check_requirements() {
  have curl || have wget || die "curl or wget is required"
  have git || die "git is required"

  if ! have node || [ "$(node_major)" -lt "$NODE_MIN_MAJOR" ]; then
    warn "Node.js >= ${NODE_MIN_MAJOR} not found; a portable runtime will be provisioned"
    PROVISION_NODE=1
  else
    PROVISION_NODE=0
    ok "node $(node -v) present"
  fi

  if have python3; then
    py_ok=$(python3 -c "import sys;print(1 if sys.version_info[:2]>=(3,10) else 0)" 2>/dev/null || echo 0)
    [ "$py_ok" = "1" ] || warn "python3 >= ${PY_MIN_MAJOR}.${PY_MIN_MINOR} recommended for the Hermes engine"
  fi
}

fetch() {
  local url="$1" dest="$2"
  if have curl; then curl -fsSL "$url" -o "$dest"; else wget -qO "$dest" "$url"; fi
}

provision_node() {
  [ "$PROVISION_NODE" = "1" ] || return 0
  local node_dir="$INSTALL_ROOT/runtime/node"
  [ -x "$node_dir/bin/node" ] && { export PATH="$node_dir/bin:$PATH"; ok "reusing provisioned node"; return 0; }

  local ver="${ALAYE_NODE_VERSION:-v22.11.0}"
  local tarball="node-${ver}-${PLATFORM}-${ARCH}.tar.gz"
  local url="https://nodejs.org/dist/${ver}/${tarball}"
  info "downloading Node.js ${ver} for ${PLATFORM}-${ARCH}"
  mkdir -p "$INSTALL_ROOT/runtime"
  fetch "$url" "$INSTALL_ROOT/runtime/$tarball"
  tar -xzf "$INSTALL_ROOT/runtime/$tarball" -C "$INSTALL_ROOT/runtime"
  rm -f "$INSTALL_ROOT/runtime/$tarball"
  rm -rf "$node_dir"
  mv "$INSTALL_ROOT/runtime/node-${ver}-${PLATFORM}-${ARCH}" "$node_dir"
  export PATH="$node_dir/bin:$PATH"
  ok "node $(node -v) provisioned"
}

# ---------------------------------------------------------------------------
# Source acquisition
# ---------------------------------------------------------------------------
SOURCE_DIR=""
acquire_source() {
  mkdir -p "$INSTALL_ROOT"
  SOURCE_DIR="$INSTALL_ROOT/src"

  if [ -f "$(dirname "$0")/../../package.json" ] && grep -q '"name": "alaye-os"' "$(dirname "$0")/../../package.json" 2>/dev/null; then
    # Running from a checkout - mirror it into the install root.
    local repo_root; repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
    info "installing from local checkout: $repo_root"
    mkdir -p "$SOURCE_DIR"
    ( cd "$repo_root" && tar --exclude=node_modules --exclude=.git --exclude=release -cf - . ) | ( cd "$SOURCE_DIR" && tar -xf - )
  else
    if [ -d "$SOURCE_DIR/.git" ]; then
      info "updating existing checkout"
      git -C "$SOURCE_DIR" fetch --depth 1 origin
      git -C "$SOURCE_DIR" checkout -q FETCH_HEAD
    else
      info "cloning $REPO_URL"
      rm -rf "$SOURCE_DIR"
      git clone --depth 1 "$REPO_URL" "$SOURCE_DIR"
    fi
    if [ "$APP_VERSION" != "latest" ]; then
      git -C "$SOURCE_DIR" fetch --depth 1 origin "refs/tags/$APP_VERSION"
      git -C "$SOURCE_DIR" checkout -q FETCH_HEAD
    fi
  fi
  ok "source ready at $SOURCE_DIR"
}

# ---------------------------------------------------------------------------
# Isolated dependency install
# ---------------------------------------------------------------------------
install_deps() {
  info "installing Node dependencies (isolated)"
  ( cd "$SOURCE_DIR" && npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund )
  ok "node dependencies installed"

  info "building renderer bundle"
  ( cd "$SOURCE_DIR/apps/desktop" && npm install --no-audit --no-fund && npm run build:renderer )
  ok "renderer built"
}

# ---------------------------------------------------------------------------
# Hermes Agent engine provisioning (isolated under ~/.alaye-os/engine)
# ---------------------------------------------------------------------------
setup_engine() {
  info "provisioning embedded Hermes agent core"
  have python3 || die "python3 is required to provision the Hermes engine"
  have git || die "git is required to fetch hermes-agent"
  mkdir -p "$ENGINE_DIR"

  local agent_dir="$ENGINE_DIR/hermes-agent"
  local venv_dir="$ENGINE_DIR/venv"

  if [ -d "$agent_dir/.git" ]; then
    info "updating existing Hermes agent repository"
    git -C "$agent_dir" fetch --depth 1 origin "$HERMES_REF"
    git -C "$agent_dir" checkout -q FETCH_HEAD
  else
    info "cloning Hermes agent from $HERMES_REPO"
    git clone --depth 1 --branch "$HERMES_REF" "$HERMES_REPO" "$agent_dir"
  fi

  if [ ! -d "$venv_dir" ]; then
    info "creating isolated Python virtualenv for Hermes"
    python3 -m venv "$venv_dir"
  fi

  "$venv_dir/bin/pip" install --quiet --upgrade pip
  info "installing Hermes agent in editable mode"
  "$venv_dir/bin/pip" install --quiet -e "$agent_dir"

  [ -x "$venv_dir/bin/hermes" ] || die "hermes binary installation failed inside $venv_dir/bin"
  ok "embedded Hermes core provisioned successfully"
}

# ---------------------------------------------------------------------------
# Production distribution artifacts (electron-builder output)
# ---------------------------------------------------------------------------
install_distribution() {
  local src="$SOURCE_DIR/release"
  if [ ! -d "$src" ]; then
    info "no packaged artifacts in $src; launcher will fall back to Electron"
    return 0
  fi
  mkdir -p "$DIST_DIR"
  local found=0
  for f in "$src"/*.AppImage "$src"/*.deb; do
    [ -e "$f" ] || continue
    cp -f "$f" "$DIST_DIR/"
    found=1
  done
  if [ "$found" = "1" ]; then
    chmod +x "$DIST_DIR"/*.AppImage 2>/dev/null || true
    ok "production artifacts staged in $DIST_DIR"
  else
    info "no AppImage/.deb found in $src"
  fi
}

# ---------------------------------------------------------------------------
# PATH + launcher
# ---------------------------------------------------------------------------
link_binaries() {
  mkdir -p "$BIN_DIR"

  # Prefer the packaged AppImage when present; otherwise run from source.
  local appimage
  appimage="$(ls "$DIST_DIR"/*.AppImage 2>/dev/null | head -n1 || true)"
  if [ -n "$appimage" ]; then
    cat > "$BIN_DIR/alaye-os" <<EOF
#!/usr/bin/env bash
export HERMES_HOME="$ENGINE_DIR"
export PATH="$ENGINE_DIR/venv/bin:\$PATH"
exec "$appimage" "\$@"
EOF
  else
    cat > "$BIN_DIR/alaye-os" <<EOF
#!/usr/bin/env bash
export HERMES_HOME="$ENGINE_DIR"
export PATH="$ENGINE_DIR/venv/bin:\$PATH"
exec "$SOURCE_DIR/node_modules/.bin/electron" "$SOURCE_DIR/apps/desktop" "\$@"
EOF
  fi
  chmod +x "$BIN_DIR/alaye-os"

  cat > "$BIN_DIR/alaye-daemon" <<EOF
#!/usr/bin/env bash
export HERMES_HOME="$ENGINE_DIR"
export PATH="$ENGINE_DIR/venv/bin:\$PATH"
exec node "$SOURCE_DIR/core/daemon/index.js" "\$@"
EOF
  chmod +x "$BIN_DIR/alaye-daemon"

  # Convenience wrapper so users can drive the embedded engine directly.
  cat > "$BIN_DIR/alaye-hermes" <<EOF
#!/usr/bin/env bash
export HERMES_HOME="$ENGINE_DIR"
export PATH="$ENGINE_DIR/venv/bin:\$PATH"
exec "$ENGINE_DIR/venv/bin/hermes" "\$@"
EOF
  chmod +x "$BIN_DIR/alaye-hermes"

  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    if ! grep -q 'alaye-os/bin' "$rc" 2>/dev/null; then
      printf '\n# Alaye OS\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$rc"
    fi
  done
  ok "launchers written to $BIN_DIR"
}

# ---------------------------------------------------------------------------
# systemd user service (Linux) / launchd (macOS)
# ---------------------------------------------------------------------------
install_service_linux() {
  have systemctl || { warn "systemctl not found; skipping service registration"; return 0; }
  local unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir"

  sed -e "s#__INSTALL_ROOT__#$SOURCE_DIR#g" \
      -e "s#__NODE_BIN__#$(command -v node)#g" \
      -e "s#__ENGINE_DIR__#$ENGINE_DIR#g" \
      -e "s#__VENV_BIN__#$VENV_DIR/bin#g" \
      "$SOURCE_DIR/core/daemon/systemd/alaye-daemon.service" > "$unit_dir/alaye-daemon.service"

  # Retire the Phase 1 unit name if it is still registered.
  if [ -f "$unit_dir/alaye-os.service" ]; then
    systemctl --user disable --now alaye-os.service 2>/dev/null || true
    rm -f "$unit_dir/alaye-os.service"
  fi

  systemctl --user daemon-reload
  systemctl --user enable --now alaye-daemon.service
  loginctl enable-linger "$USER" 2>/dev/null || warn "could not enable lingering (daemon may stop at logout)"
  ok "systemd user service alaye-daemon.service enabled (HERMES_HOME=$ENGINE_DIR)"
}

install_service_darwin() {
  local plist="$HOME/Library/LaunchAgents/os.alaye.daemon.plist"
  mkdir -p "$(dirname "$plist")"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>os.alaye.daemon</string>
  <key>ProgramArguments</key>
  <array><string>$(command -v node)</string><string>$SOURCE_DIR/core/daemon/index.js</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HERMES_HOME</key><string>$ENGINE_DIR</string>
    <key>HERMES_BIN</key><string>$HERMES_BIN</string>
    <key>PATH</key><string>$VENV_DIR/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$INSTALL_ROOT/daemon.log</string>
  <key>StandardErrorPath</key><string>$INSTALL_ROOT/daemon.err.log</string>
</dict>
</plist>
EOF
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  ok "launchd agent os.alaye.daemon loaded"
}

install_service() {
  [ "$WITH_SERVICE" = "1" ] || { info "service registration skipped"; return 0; }
  case "$PLATFORM" in
    linux) install_service_linux ;;
    darwin) install_service_darwin ;;
  esac
}

# ---------------------------------------------------------------------------
# Desktop shortcut
# ---------------------------------------------------------------------------
install_desktop_entry() {
  [ "$WITH_DESKTOP" = "1" ] || return 0
  [ "$PLATFORM" = "linux" ] || return 0

  local apps_dir="$HOME/.local/share/applications"
  local icon_dir="$HOME/.local/share/icons/hicolor/256x256/apps"
  mkdir -p "$apps_dir" "$icon_dir"

  if [ -f "$SOURCE_DIR/apps/desktop/build/icon.png" ]; then
    cp "$SOURCE_DIR/apps/desktop/build/icon.png" "$icon_dir/alaye-os.png"
  fi

  cat > "$apps_dir/alaye-os.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Alaye OS
Comment=B2B outreach agent console
Exec=$BIN_DIR/alaye-os %U
Icon=alaye-os
Terminal=false
Categories=Office;Network;
StartupWMClass=Alaye OS
EOF
  chmod +x "$apps_dir/alaye-os.desktop"
  update-desktop-database "$apps_dir" 2>/dev/null || true
  ok "desktop shortcut installed"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  mkdir -p "$INSTALL_ROOT"
  info "installing $APP_NAME into $INSTALL_ROOT"
  detect_platform
  check_requirements
  provision_node
  acquire_source
  setup_engine
  install_deps
  install_distribution
  link_binaries
  install_service
  install_desktop_entry

  cat > "$INSTALL_ROOT/alaye.env" <<EOF
# Alaye OS environment - populate provider credentials here.
# ALAYE_LOG_LEVEL=info
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# OLLAMA_ENDPOINT=http://127.0.0.1:11434
# HERMES_HOME=$ENGINE_DIR
# HERMES_BIN=$HERMES_BIN
EOF

  printf '\n'
  ok "$APP_NAME installed successfully"
  info "launch the app:   $BIN_DIR/alaye-os"
  info "hermes CLI:       $HERMES_BIN"
  info "release artifacts: $DIST_DIR"
  info "daemon status:    systemctl --user status alaye-daemon   (Linux)"
  info "logs:             $LOG_FILE"
}

main "$@" | tee -a "$LOG_FILE"
