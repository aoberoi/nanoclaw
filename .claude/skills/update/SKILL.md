---
name: update
description: Pull latest code, rebuild, and restart NanoClaw. Works locally on the server or remotely via SSH. Requires Docker runtime. Triggers on "update", "pull latest", "upgrade", "self-update", or "deploy latest".
---

# Update NanoClaw

Pull the latest code from origin, install dependencies, rebuild, and restart the service.

## 1. Detect Environment

Determine where this skill is running and how to reach the NanoClaw instance:

```bash
hostname
uname -s
```

**Local (on the NanoClaw machine itself):** Commands run directly.

**Remote (from a different machine):** Commands run via SSH. Check that the `nanoclaw` SSH alias works:

```bash
ssh nanoclaw 'echo "OK"'
```

If that fails, check `~/.ssh/config` for the `nanoclaw` host entry, or AskUserQuestion for the server's IP address and SSH user. Use `ssh USER@IP_ADDRESS` for all subsequent commands.

Define a helper for the rest of the skill:
- **Local:** `run() { eval "$1"; }`
- **Remote:** `run() { ssh nanoclaw "$1"; }` (use `run_root() { ssh nanoclaw-root "$1"; }` when root is needed)

### Detect target platform

The platform of the **NanoClaw machine** (not the machine you're running this skill from) determines service management commands:

```bash
run 'uname -s'
```

Record the result: `Linux` or `Darwin` (macOS). Use this in steps 7 and 8.

### Verify Docker is available

```bash
run 'docker info >/dev/null 2>&1 && echo "docker-ok" || echo "docker-unavailable"'
```

**If docker-unavailable:** Stop. Tell the user this skill requires Docker to be installed and running on the NanoClaw machine, and cannot proceed.

## 2. Pre-flight Checks

Check the current state before making changes:

```bash
# Current commit
run 'cd ~/nanoclaw && git rev-parse --short HEAD'

# Any local changes that would block git pull?
run 'cd ~/nanoclaw && git status --porcelain'
```

**If there are uncommitted changes:** Warn the user and AskUserQuestion: stash them, discard them, or abort the update.

**If git status is clean:** Proceed.

## 3. Pull Latest

```bash
run 'cd ~/nanoclaw && git pull'
```

**If merge conflicts occur:** Stop and report to the user. Do not attempt to resolve automatically.

**If already up to date:** Report this to the user. AskUserQuestion: continue with rebuild anyway, or skip? (Rebuilding can be useful if the container image or dependencies need refreshing.)

Show the user what changed:

```bash
run 'cd ~/nanoclaw && git log --oneline -5'
```

## 4. Install Dependencies

```bash
run 'cd ~/nanoclaw && npm install'
```

**If this fails** on `better-sqlite3` or other native modules: install build tools (`build-essential python3` on Linux, `xcode-select --install` on macOS) and retry.

## 5. Build

```bash
run 'cd ~/nanoclaw && npm run build'
```

**If TypeScript compilation fails:** Report the errors to the user. Do not proceed to restart — the service should keep running the previous working build.

## 6. Rebuild Container Image

```bash
run 'cd ~/nanoclaw && ./container/build.sh'
```

Verify:

```bash
run 'docker run --rm --entrypoint /bin/echo nanoclaw-agent:latest "OK"'
```

**If the build fails:** Try pruning the build cache and retrying:

```bash
run 'docker builder prune -f'
run 'cd ~/nanoclaw && ./container/build.sh'
```

## 7. Restart Service (if running)

Check if a service is configured on the NanoClaw machine and restart it. Skip this step if no service is found.

**If target platform is Linux:**
```bash
run 'systemctl --user is-active nanoclaw 2>/dev/null && systemctl --user restart nanoclaw && echo "Service restarted" || echo "No service configured"'
```

**If target platform is macOS:**
```bash
run 'launchctl print gui/$(id -u)/com.nanoclaw 2>/dev/null && launchctl kickstart -k gui/$(id -u)/com.nanoclaw && echo "Service restarted" || echo "No service configured"'
```

## 8. Verify

If the service was restarted, wait 3-5 seconds then check:

**If target platform is Linux:**
```bash
run 'systemctl --user is-active nanoclaw'
run 'tail -5 ~/nanoclaw/logs/nanoclaw.log'
```

**If target platform is macOS:**
```bash
run 'launchctl print gui/$(id -u)/com.nanoclaw | head -5'
run 'tail -5 ~/nanoclaw/logs/nanoclaw.log'
```

Report the new commit hash and confirm the service status.
