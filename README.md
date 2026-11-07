# Alaye OS

White-labeled B2B outreach agent for commercial distribution, built on an
embedded **Hermes Agent** execution core. Alaye OS pairs a dark Electron
desktop console with a persistent background daemon, an isolated Python engine,
an Obsidian-style memory vault, and an over-the-air update channel.

---

## Features

- **Chat Console** — streaming conversation with the embedded Hermes agent,
  markdown + code rendering, quick actions, session reset.
- **Campaign Dashboard** — live sent/reply/interested metrics, campaign status,
  and active background cron loops.
- **Template Editor** — Markdown templates with `{{first_name}}`, `{{company}}`,
  `{{pain_point}}` variable injection and live preview.
- **Triage Inbox** — inbound replies classified as Interested / Objection /
  Unsubscribe, with desktop alerts.
- **Memory Vault** — searchable Markdown "second brain" for leads, objections,
  and company context.
- **Sender Personas** — Founder / SDR / Ops identities with their own signature,
  tone, and provider binding. The agent adopts the active persona automatically.
- **Email transports** — Composio (Gmail/Outlook), Resend, SendGrid, SMTP, with
  an offline dry-run fallback.
- **Secure credentials** — provider keys and OAuth tokens stored in the OS
  keychain via `keytar` (GNOME Keyring / macOS Keychain / Windows Credential
  Manager).
- **OTA updates** — syncs skills, template bundles, and engine patches from a
  GitHub/S3 release manifest.

---

## Architecture

```
apps/desktop            Electron shell (main + preload + React/Tailwind renderer)
  main/                 window, daemon supervisor, IPC, event bridge
  preload/              context-isolated window.alaye / window.electronAPI
  renderer/             React views (Chat, Campaigns, Templates, Triage, Memory, Settings)
core/daemon             JSON-RPC daemon over a unix socket / named pipe
  services/             email-service, persona-service, memory-service
  systemd/              systemd user unit
core/updater            OTA manifest / download / verify / stage / swap
core/shared             IPC + protocol constants
scripts/installer       install.sh (POSIX), install.ps1 (Windows)
```

The daemon supervises the embedded `hermes` CLI, owns the cron loops, and
streams agent tokens to the renderer. The desktop shell never talks to the
engine directly; everything flows through the daemon socket.

---

## Requirements

| Component | Minimum |
|-----------|---------|
| Node.js | 20.x (22 recommended) |
| Python | 3.10+ with `venv` and `pip` |
| Git | any recent version |
| Linux build host | `libsecret-1-dev` for keytar, plus `fakeroot`, `dpkg` for `.deb` |
| Windows build host | Visual Studio Build Tools for native modules |

---

## Installation

### Option A — POSIX installer (Linux / macOS)

From a local checkout (recommended while the release repo is private):

```bash
git clone https://github.com/frdp001/agentos.git
cd alaye-os
./scripts/installer/install.sh
```

When piped from the internet:

```bash
curl -fsSL https://raw.githubusercontent.com/frdp001/agentos/main/scripts/installer/install.sh | bash
```

The installer is idempotent. It will:

1. Detect platform/arch and provision a portable Node.js if needed.
2. Mirror the source into `~/.alaye-os/src`.
3. Install Node dependencies and build the renderer.
4. Clone `hermes-agent` into `~/.alaye-os/engine/hermes-agent`, create
   `~/.alaye-os/engine/venv`, and `pip install -e` it so
   `~/.alaye-os/engine/venv/bin/hermes` exists.
5. Stage packaged artifacts from `release/` (AppImage/.deb) when present.
6. Register a systemd **user** service (Linux) or launchd agent (macOS).
7. Add a desktop shortcut and `~/.alaye-os/bin` launchers.

Options:

```bash
./install.sh --prefix ~/.alaye-os     # install root
./install.sh --version v0.1.0         # app tag
./install.sh --repo  <git-url>        # app repository
./install.sh --no-service             # skip systemd/launchd
./install.sh --no-desktop             # skip desktop shortcut
```

Engine overrides (environment): `ALAYE_HERMES_REPO`, `ALAYE_HERMES_REF`,
`ALAYE_NODE_VERSION`.

### Option B — Windows installer

```powershell
git clone https://github.com/frdp001/agentos.git
cd alaye-os
powershell -ExecutionPolicy Bypass -File scripts\installer\install.ps1
```

Parameters: `-InstallRoot`, `-Version`, `-RepoUrl`, `-HermesRepo`, `-NoService`,
`-NoDesktop`.

It provisions `%LOCALAPPDATA%\alaye-os`, builds the same isolated engine venv at
`%LOCALAPPDATA%\alaye-os\engine\venv`, and registers the logon task
**AlayeOS Hermes Gateway** (runs through `alaye-daemon.cmd` so `HERMES_HOME`,
`HERMES_BIN`, and `PATH` point at the embedded venv).

### Option C — Manual development setup

```bash
# 1. Install workspace dependencies
npm install

# 2. Provision the engine (macOS/Linux)
export ALAYE_INSTALL_ROOT="$HOME/.alaye-os"
mkdir -p "$ALAYE_INSTALL_ROOT/engine"
git clone --depth 1 --branch main \
  https://github.com/nousresearch/hermes-agent.git \
  "$ALAYE_INSTALL_ROOT/engine/hermes-agent"
python3 -m venv "$ALAYE_INSTALL_ROOT/engine/venv"
"$ALAYE_INSTALL_ROOT/engine/venv/bin/pip" install -e "$ALAYE_INSTALL_ROOT/engine/hermes-agent"

# 3. Run the daemon and the desktop shell
npm run daemon        # terminal 1
npm run dev           # terminal 2 (Vite + Electron)
```

> The app still runs without the engine: the daemon reports "scaffold mode" and
> the Chat Console streams deterministic local replies.

---

## Development

| Command | What it does |
|---------|--------------|
| `npm run dev` | Vite renderer (:5273) + Electron with hot reload |
| `npm run daemon` | Run the background daemon directly |
| `npm run build` | Build renderer then package unpacked app (`electron-builder --dir`) |
| `npm run dist` | Build platform installers |
| `npm run update` | Check the OTA manifest for updates |
| `npm run lint` | ESLint |

---

## Configuration

### Environment variables

Set these in `~/.alaye-os/alaye.env` (sourced by the systemd unit) or your shell.

| Variable | Purpose | Default |
|----------|---------|---------|
| `ALAYE_INSTALL_ROOT` | Install root | `~/.alaye-os` |
| `ALAYE_DATA_DIR` | JSON state (templates, campaigns, replies, personas) | `~/.alaye-os/data` |
| `ALAYE_MEMORY_DIR` | Markdown vault | `~/.alaye-os/memory` |
| `ALAYE_LOG_LEVEL` | `error` / `warn` / `info` / `debug` | `info` |
| `ALAYE_SOCKET` | Daemon socket path | runtime dir / named pipe |
| `HERMES_HOME` | Embedded engine root | `~/.alaye-os/engine` |
| `HERMES_BIN` | Explicit `hermes` binary | auto-resolved |
| `COMPOSIO_API_KEY` | Composio API key | — |
| `COMPOSIO_USER_ID` | Composio end-user id | `alaye-os` |
| `COMPOSIO_GMAIL_ACCOUNT_ID` | Connected Gmail account | — |
| `COMPOSIO_OUTLOOK_ACCOUNT_ID` | Connected Outlook account | — |
| `RESEND_API_KEY` | Resend API key | — |
| `SENDGRID_API_KEY` | SendGrid API key | — |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | SMTP fallback | — |
| `IMAP_HOST` / `IMAP_PORT` / `IMAP_USER` / `IMAP_PASS` | IMAP inbound | — |
| `ALAYE_UPDATE_MANIFEST` | OTA manifest URL | GitHub release URL |

Transport is chosen in order: **Composio → Resend → SendGrid → SMTP → dry-run**.

### Provider / Token Harbor (bake-in or edit post-install)

An editable OpenAI-compatible provider config ships with the app at
`apps/desktop/config/default-provider.json`:

```json
{
  "provider": "token-harbor",
  "openai_api_key": "YOUR_TOKEN_HARBOR_KEY_HERE",
  "openai_base_url": "https://api.tokenharbor.ai/v1",
  "default_model": "qwen2.5-coder"
}
```

- **Before packaging** — edit this file, then `npm run dist:win`. It is copied to
  `resources/config/default-provider.json` in the release payload
  (e.g. `release/win-unpacked/resources/config/default-provider.json`).
- **After installation** — edit the copy under the installed app's
  `resources/config/` or create `~/.alaye-os/data/default-provider.json`, then
  restart the daemon. You can also set `ALAYE_PROVIDER_CONFIG` to any path.

At spawn time the daemon injects `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and
`DEFAULT_MODEL` into the embedded `hermes` process from this config (and/or
`~/.alaye-os/alaye.env`). Placeholder values beginning with `YOUR_` are ignored,
and ambient environment variables always take precedence. The Settings view
pre-populates the base URL, model, and provider from this config when no key is
stored in the keychain.

### Credentials (keychain)

Open **Settings → Providers & Credentials** and paste keys. They are stored via
`keytar` in the OS keychain. If `keytar` is unavailable, the app falls back to
the encrypted config store and the UI shows the active backend.

Non-secret transport settings (hosts, ports, account ids) can be placed in
`~/.alaye-os/data/email.json`; secrets should stay in the keychain or
environment.

### Personas

Seeded personas: `founder`, `sdr`, `ops`. Change the active persona from the
Chat Console or Settings. The active persona's name, signature, tone, and
provider binding are injected into every agent prompt and outbound email.

### Memory vault

```
~/.alaye-os/memory/
  leads/            one note per prospect/company
  objections/       recurring objections + rebuttals
  company_context/  positioning and firmographics
```

Files are plain Markdown with YAML frontmatter and can be edited in Obsidian.
The agent reads relevant notes before generating and writes learnings during
triage. Browse and search them in the **Memory Vault** view.

---

## Build & distribution

```bash
# Linux: AppImage + .deb
npm run dist:linux --workspace @alaye/desktop

# Windows: NSIS standalone installer
npm run dist:win --workspace @alaye/desktop

# macOS: dmg
npm run dist:mac --workspace @alaye/desktop
```

Artifacts land in `release/`. Configuration lives in
`apps/desktop/electron-builder.yml` (referenced from `package.json` via
`"build": { "extends": "./electron-builder.yml" }`).

### Windows engine bundling (self-contained installer)

By default the NSIS installer ships the UI but not the Python engine, so the
daemon runs in scaffold mode until an engine exists. To make the installer
self-contained (no Python/git/network on the target), bundle the engine first:

```powershell
# On a Windows build host (needs Python 3.10+ and git):
npm run bundle:engine:win        # generates apps/desktop/engine-bundle/
npm run dist:win                 # bundles it as resources/engine into the NSIS payload
```

`bundle:engine:win` runs `scripts/bundle-engine.ps1`, which:

1. Downloads an embeddable CPython runtime into `engine-bundle/python/`.
2. `pip install`s `hermes-agent` and its dependencies into
   `engine-bundle/python/Lib/site-packages/`.
3. Generates `hermes_launcher.py` + `hermes.cmd` shims and
   `bundle-manifest.json`.

electron-builder then copies `engine-bundle/` to `resources/engine`, and the
daemon sets `ALAYE_ENGINE_DIR` to it. `gateway.js` resolves the bundled
`hermes` via the embedded Python launcher (falling back to a venv or a global
`hermes`). Expect roughly **80–300 MB** added to the installer; run
`ALAYE_HERMES_REPO`/`ALAYE_HERMES_REF` env vars to pin the engine source.

`engine-bundle/` is generated and git-ignored. When it is empty the packaging
step simply copies nothing and the app falls back to the venv/global engine.

> Engine upgrades can still ship via the OTA `engine-patches` channel without a
> full reinstall.

The installer stages `release/*.AppImage` and `release/*.deb` into
`~/.alaye-os/release` and makes the `alaye-os` launcher prefer the AppImage when
present. On Windows the launcher prefers
`release\win-unpacked\Alaye OS.exe`.

> Native modules are **not** rebuilt during packaging (`npmRebuild: false`).
> Build `keytar` on a host with `libsecret-1-dev` (Linux) or the Windows SDK
> before producing a release that must use the OS keychain.

---

## Services

| Platform | Service |
|----------|---------|
| Linux | `systemctl --user status alaye-daemon` · logs: `journalctl --user -u alaye-daemon` |
| macOS | `launchctl list \| grep os.alaye` |
| Windows | `Get-ScheduledTask -TaskName "AlayeOS Hermes Gateway"` |

The daemon socket lives under `$XDG_RUNTIME_DIR/alaye-hermes.sock` (or
`\\.\pipe\alaye-os-hermes` on Windows) and is chmod `0600`.

---

## OTA updates

```bash
npm run update                 # check
node core/updater/index.js --apply   # download, verify SHA-256, stage + swap
```

Components: `agent-skills`, `template-bundles`, `engine-patches`. Downloads are
checksum-verified and extracted with a path-traversal guard before an atomic
swap with backup.

---

## Troubleshooting

**`keytar` build fails (`libsecret-1 was not found`)**
Install the dev headers, then reinstall:
```bash
sudo apt install libsecret-1-dev   # Debian/Ubuntu
npm rebuild keytar
```

**Engine not found / "scaffold mode"**
```bash
~/.alaye-os/engine/venv/bin/hermes --version
systemctl --user restart alaye-daemon
```
Ensure `HERMES_HOME=~/.alaye-os/engine` and that the venv contains `bin/hermes`
(`Scripts\hermes.exe` on Windows).

**Daemon cannot connect (socket ENOENT)**
The daemon may have exited. Check `journalctl --user -u alaye-daemon` or run
`npm run daemon` in the foreground. A stale socket is removed on startup.

**Desktop app shows "Engine offline"**
The shell can still run, but chat falls back to scaffold replies. Confirm the
daemon is running and the socket path matches between the daemon and the shell.

**Build cannot compute Electron version**
Pin `electron` to an exact version in `apps/desktop/package.json` (done by
default) so `electron-builder` can resolve it.

---

## Security notes

- Renderer runs with `contextIsolation`, `sandbox`, and `nodeIntegration: false`.
- Permissions (camera/mic/geolocation) are denied by default; external links open
  in the OS browser.
- Secrets are allow-listed and never logged; reads return presence, not values.
- The daemon socket is user-private; the systemd unit is hardened
  (`NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=~/.alaye-os`).
- Only send outreach to recipients who have consented under applicable law
  (e.g., CAN-SPAM, GDPR/PECR). You are responsible for your sending practices.

---

## License

Proprietary / UNLICENSED. Copyright (c) Alaye Systems.