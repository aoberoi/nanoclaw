---
name: deploy-to-linux
description: Deploy NanoClaw to a cloud Linux VM. Guides through provider selection, server provisioning, and full setup. Triggers on "deploy", "cloud", "linux server", "VPS", "hetzner", "digitalocean", "vultr", or "production server".
---

# Deploy NanoClaw to a Linux Server

This skill deploys NanoClaw to a cloud Linux VM. It covers provider selection, server setup, and running `/setup` on the remote machine.

## Prerequisites

- NanoClaw source code must already use Docker (not Apple Container). Check: `grep -q 'docker info' src/index.ts`. If not, run `/convert-to-docker` first.
- User needs an SSH key (check `~/.ssh/*.pub`). If none exists, generate one: `ssh-keygen -t ed25519`

## 1. Choose a Cloud Provider

### 1a. Present Server Requirements

Before researching providers, present NanoClaw's server requirements to the user and let them adjust:

**NanoClaw server requirements:**
- **RAM:** 2 GB minimum, 4 GB recommended (orchestrator + Docker containers can OOM under load with less)
- **Disk:** 20 GB minimum (OS + Docker images + logs + message store)
- **OS:** Ubuntu 24.04 LTS (other Debian-based distros may work but are untested)
- **Docker support:** Required (installed in step 4)
- **Architecture:** x86_64 or ARM64

AskUserQuestion: Here are the server requirements. Do you have any adjustments or additional preferences? (e.g. region/location, budget limit, specific provider preference, ARM vs x86)

Incorporate the user's preferences into the research query.

### 1b. Research Current Providers

Use WebSearch to find current pricing and availability for cloud VPS providers that meet the requirements. Search for something like "cheapest cloud VPS 2GB RAM Ubuntu 2026 pricing" (use the current year). Check at least 3-4 major providers (Hetzner, DigitalOcean, Vultr, Linode, Oracle Cloud, etc.).

Present findings to the user as a comparison table with:
- Provider name
- Plan name and specs (vCPU, RAM, disk)
- Monthly price
- Available regions
- Notable pros/cons

Include any free-tier options (e.g. Oracle Cloud ARM) with honest caveats about availability.

AskUserQuestion: Which provider would you like to use?

## 2. Provision the Server

Guide the user through their chosen provider's console. The goal: a fresh Ubuntu 24.04 server with their SSH key.

### Hetzner

1. Sign up at https://console.hetzner.cloud/registration
2. Create a project
3. **Security** → **SSH Keys** → **Add SSH Key** — paste the user's public key (`cat ~/.ssh/*.pub`)
4. **Servers** → **Add Server**:
   - Location: any available (Nuremberg, Falkenstein, or Helsinki)
   - Image: **Ubuntu 24.04**
   - Type: **CX22** (2 vCPU, 4 GB RAM, 40 GB NVMe) — ~$4/mo
   - SSH Key: select the key added above
   - Name: `nanoclaw`
5. Note the public IP address

### DigitalOcean

1. Sign up at https://cloud.digitalocean.com/registrations/new
2. **Settings** → **Security** → **Add SSH Key** — paste user's public key
3. **Create** → **Droplets**:
   - Region: any (recommend nearest)
   - Image: **Ubuntu 24.04**
   - Size: **Basic $12/mo** (1 vCPU, 2 GB RAM) minimum
   - SSH Key: select the key added above
   - Hostname: `nanoclaw`
4. Note the public IP address

### Vultr

1. Sign up at https://my.vultr.com/
2. **Deploy** → **Cloud Compute**:
   - Location: any
   - Image: **Ubuntu 24.04**
   - Plan: **Regular $6/mo** (1 vCPU, 1 GB) minimum, $12/mo (2 GB) recommended
   - SSH Key: add user's public key
   - Hostname: `nanoclaw`
3. Note the public IP address

### Oracle Cloud (Free Tier)

1. Sign up at https://cloud.oracle.com/
2. **Compute** → **Instances** → **Create Instance**:
   - Image: **Ubuntu 24.04** (Canonical)
   - Shape: **VM.Standard.A1.Flex** (ARM) — 4 OCPU, 24 GB RAM (free)
   - SSH Key: paste user's public key
   - Note: may get "Out of Capacity" errors. Keep retrying or try a different availability domain.
3. Note the public IP address
4. **Important:** Oracle uses username `ubuntu` by default, not `root`

## 3. Verify SSH Access

Test the connection (replace IP_ADDRESS with the server's IP):

```bash
ssh -o StrictHostKeyChecking=accept-new root@IP_ADDRESS "echo 'Connected!' && uname -a && free -h"
```

If the provider uses a different default user (e.g. Oracle uses `ubuntu`), adjust accordingly and use `sudo` for root commands.

## 4. Install Dependencies

Run all of these as root on the server:

### 4a. System updates

```bash
ssh root@IP_ADDRESS 'apt-get update && apt-get upgrade -y'
```

If the output mentions "System restart required", reboot:
```bash
ssh root@IP_ADDRESS 'reboot'
# Wait 15-20 seconds, then verify:
ssh root@IP_ADDRESS 'echo "Back up"'
```

### 4b. Docker

```bash
ssh root@IP_ADDRESS 'apt-get install -y ca-certificates curl gnupg && install -m 0755 -d /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list && apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io'
```

### 4c. Node.js (latest LTS)

```bash
ssh root@IP_ADDRESS 'curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs'
```

### 4d. Build tools and utilities

Build tools are needed for the `better-sqlite3` native module. The `sqlite3` CLI is used by setup scripts for database operations.

```bash
ssh root@IP_ADDRESS 'apt-get install -y build-essential python3 git sqlite3'
```

### 4e. Verify installations

```bash
ssh root@IP_ADDRESS 'docker --version && node --version && npm --version && git --version'
```

## 5. Create Application User

Create a dedicated `nanoclaw` user (don't run the app as root):

```bash
ssh root@IP_ADDRESS 'useradd -m -s /bin/bash nanoclaw && usermod -aG docker nanoclaw'
```

Copy SSH authorized keys so the user can SSH directly:

```bash
ssh root@IP_ADDRESS 'mkdir -p /home/nanoclaw/.ssh && cp /root/.ssh/authorized_keys /home/nanoclaw/.ssh/authorized_keys && chown -R nanoclaw:nanoclaw /home/nanoclaw/.ssh && chmod 700 /home/nanoclaw/.ssh && chmod 600 /home/nanoclaw/.ssh/authorized_keys'
```

Verify direct SSH works:

```bash
ssh nanoclaw@IP_ADDRESS 'echo "Connected as $(whoami)"'
```

## 6. Set Up SSH Aliases (Optional)

AskUserQuestion: Would you like me to add SSH aliases to `~/.ssh/config`? This lets you type `ssh nanoclaw` instead of `ssh nanoclaw@IP_ADDRESS`. (Options: Yes / No, I'll use the full address)

**If yes:** Read `~/.ssh/config`, then insert BEFORE any `Host *` block:

```
Host nanoclaw
    HostName IP_ADDRESS
    User nanoclaw

Host nanoclaw-root
    HostName IP_ADDRESS
    User root
```

Verify: `ssh nanoclaw 'echo "OK"'`

**If no:** Use `nanoclaw@IP_ADDRESS` and `root@IP_ADDRESS` in all subsequent commands instead of the aliases.

## 7. Clone and Build

**Note:** Steps 7–11 and Post-Deployment use the SSH aliases `nanoclaw` and `nanoclaw-root`. If the user declined aliases in step 6, substitute `nanoclaw@IP_ADDRESS` and `root@IP_ADDRESS` respectively.

```bash
ssh nanoclaw 'git clone REPO_URL ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build'
```

If `npm install` fails on `better-sqlite3` with "not found: make", the build tools from step 4d are missing. Install them via `ssh nanoclaw-root 'apt-get install -y build-essential python3'` and retry.

## 8. Build Docker Image

```bash
ssh nanoclaw 'cd ~/nanoclaw && ./container/build.sh'
```

This takes 2-5 minutes. Verify:

```bash
ssh nanoclaw 'docker run --rm --entrypoint /bin/echo nanoclaw-agent:latest "OK"'
```

## 9. Install Claude Code

Check the official installation docs at https://code.claude.com/docs/en/setup using WebFetch to find the current recommended installation method for Linux. Follow those instructions on the server (run commands as the `nanoclaw` user via `ssh nanoclaw '...'`, using `ssh nanoclaw-root` if root is needed).

After installation, ensure `claude` is in the user's PATH. If the installer places it in a directory not on PATH (e.g. `~/.local/bin`), add it:

```bash
ssh nanoclaw 'echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> ~/.profile'
```

Verify:

```bash
ssh nanoclaw 'source ~/.profile && claude --version'
```

## 10. Run Setup on the Server

Tell the user to SSH into the server and run `/setup` interactively:

```bash
ssh nanoclaw
cd ~/nanoclaw
claude
```

Then type `/setup` inside Claude Code. This handles:
- Claude authentication (OAuth token or API key)
- WhatsApp authentication (QR code)
- Channel registration
- systemd service configuration

**Important notes for the user:**
- WhatsApp QR code authentication: the setup script can open a browser-based QR page. Since this is a headless server, choose the **pairing code** method or use **QR code in terminal** if their terminal supports it.
- Claude authentication: run `claude` and follow the `/login` prompts. If the OAuth URL fails with scope errors, try copy-pasting carefully — formatting issues during copy/paste are a common cause.
- The `.env` file (`~/nanoclaw/.env`) needs `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` for the agent containers. This is separate from Claude Code's own authentication.

## 11. Verify Deployment

After `/setup` completes, verify everything:

```bash
# Service is running
ssh nanoclaw 'systemctl --user status nanoclaw'

# Logs look healthy
ssh nanoclaw 'tail -20 ~/nanoclaw/logs/nanoclaw.log'

# Send a test message via WhatsApp
```

## Post-Deployment

### Monitoring logs
```bash
ssh nanoclaw 'tail -f ~/nanoclaw/logs/nanoclaw.log'
```

### Restarting the service
```bash
ssh nanoclaw 'systemctl --user restart nanoclaw'
```

### Updating NanoClaw
```bash
ssh nanoclaw 'cd ~/nanoclaw && git pull && npm install && npm run build && ./container/build.sh && systemctl --user restart nanoclaw'
```

### System updates
```bash
ssh nanoclaw-root 'apt-get update && apt-get upgrade -y'
# Reboot if kernel updates were applied:
ssh nanoclaw-root 'reboot'
```
