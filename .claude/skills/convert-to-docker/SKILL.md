---
name: convert-to-docker
description: Convert NanoClaw from Apple Container to Docker for cross-platform support. Use when user wants to run on Linux, switch to Docker, enable cross-platform deployment, or migrate away from Apple Container. Triggers on "docker", "linux support", "convert to docker", "cross-platform", or "replace apple container".
disable-model-invocation: true
---

# Convert to Docker

This skill migrates NanoClaw from Apple Container (macOS-only) to Docker for cross-platform support (macOS and Linux).

**What this changes:**
- Container runtime: Apple Container → Docker
- Mount syntax: `--mount type=bind,...,readonly` → `-v path:path:ro`
- Startup check: `container system status` → `docker info`
- Orphan cleanup: `container ls --format json` (JSON array) → `docker ps --format json` (newline-delimited JSON)
- Timeout stop: `container stop` → `docker stop`
- Build commands: `container build/run` → `docker build/run`

**What stays the same:**
- Dockerfile (already Docker-compatible)
- Agent runner code
- Mount security/allowlist validation
- All other functionality

## Prerequisites

Verify Docker is installed before starting:

```bash
docker --version && docker info >/dev/null 2>&1 && echo "Docker ready" || echo "Install Docker first"
```

If Docker is not installed:
- **macOS**: `brew install --cask docker`, then open Docker Desktop
- **Linux**: `curl -fsSL https://get.docker.com | sh && sudo systemctl start docker && sudo usermod -aG docker $USER`

## 1. Update Container Runner (`src/container-runner.ts`)

### 1a. Update module comment (line 3)

```typescript
// Before:
 * Spawns agent execution in Apple Container and handles IPC

// After:
 * Spawns agent execution in Docker containers and handles IPC
```

### 1b. Remove Apple Container-specific comments

Remove these comments if they exist (they may be on different lines):

- `// Apple Container only supports directory mounts, not file mounts`
- `// Bypasses Apple Container's sticky build cache for code changes.`

### 1c. Replace `buildContainerArgs` function

The key differences: Docker's `-v` supports `:ro` suffix (Apple Container required `--mount` for readonly). Keep the `containerName` parameter and `--name` flag — they're needed for orphan cleanup and `docker stop`.

```typescript
function buildContainerArgs(mounts: VolumeMount[], containerName: string): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  for (const mount of mounts) {
    const ro = mount.readonly ? ':ro' : '';
    args.push('-v', `${mount.hostPath}:${mount.containerPath}${ro}`);
  }

  args.push(CONTAINER_IMAGE);

  return args;
}
```

### 1d. Update spawn command

```typescript
// Before:
    const container = spawn('container', containerArgs, {

// After:
    const container = spawn('docker', containerArgs, {
```

### 1e. Update timeout stop command

Find the `killOnTimeout` function and update:

```typescript
// Before:
      exec(`container stop ${containerName}`, { timeout: 15000 }, (err) => {

// After:
      exec(`docker stop ${containerName}`, { timeout: 15000 }, (err) => {
```

## 2. Update Startup Check (`src/index.ts`)

### 2a. Replace the entire `ensureContainerSystemRunning()` function

Apple Container needed `container system start`. Docker's daemon is managed by systemd/Docker Desktop — we just check if it's running.

**Critical difference in orphan cleanup:** Apple Container's `container ls --format json` returns a JSON array (`[{status, configuration: {id}}]`). Docker's `docker ps --format json` returns **newline-delimited JSON objects** (`{Names: "..."}` per line). The `--filter name=nanoclaw-` flag lets Docker do the filtering for us.

```typescript
function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe' });
    logger.debug('Docker daemon running');
  } catch {
    logger.error('Docker daemon is not running');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Docker daemon is not running                           ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without Docker. To fix:                    ║',
    );
    console.error(
      '║  1. Install Docker: https://docs.docker.com/get-docker/      ║',
    );
    console.error(
      '║  2. Start Docker: sudo systemctl start docker                 ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                          ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Docker daemon is required but not running');
  }

  // Kill and clean up orphaned NanoClaw containers from previous runs
  try {
    const output = execSync(
      'docker ps --format json --filter name=nanoclaw-',
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans: string[] = [];
    for (const line of output.trim().split('\n')) {
      if (!line) continue;
      try {
        const container: { Names: string } = JSON.parse(line);
        orphans.push(container.Names);
      } catch { /* skip malformed lines */ }
    }
    for (const name of orphans) {
      try {
        execSync(`docker stop ${name}`, { stdio: 'pipe' });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
```

### 2b. Update the call site in `main()`

```typescript
// Before:
  ensureContainerSystemRunning();

// After:
  ensureDockerRunning();
```

## 3. Update Build Script (`container/build.sh`)

```bash
# Before:
# Build with Apple Container
container build -t "${IMAGE_NAME}:${TAG}" .
# ...
#   echo '...' | container run -i ${IMAGE_NAME}:${TAG}

# After:
# Build with Docker
docker build -t "${IMAGE_NAME}:${TAG}" .
# ...
#   echo '...' | docker run -i ${IMAGE_NAME}:${TAG}
```

## 4. Update Documentation

### `CLAUDE.md`

| Find | Replace |
|------|---------|
| `Apple Container (Linux VMs)` | `Docker containers` |
| `container builder stop && container builder rm && container builder start` | `docker builder prune -f` |
| `container run -i --rm --entrypoint wc` | `docker run --rm --entrypoint wc` |

Add Linux service management alongside macOS:
```markdown
# Linux (systemd)
sudo systemctl start nanoclaw
sudo systemctl stop nanoclaw
```

### `README.md`

| Find | Replace |
|------|---------|
| `Apple Container (macOS) or Docker (macOS/Linux)` | `Docker containers` |
| `Agents sandboxed in Apple Container (macOS) or Docker (macOS/Linux)` | `Agents sandboxed in Docker containers` |
| Requirements: `[Apple Container](...) (macOS) or [Docker](...)` | `[Docker](https://docs.docker.com/get-docker/)` |

Remove the "Why Apple Container instead of Docker?" FAQ entry. Simplify "Can I run this on Linux?" to note Docker works on both platforms.

### `docs/REQUIREMENTS.md`

| Find | Replace |
|------|---------|
| `agents run in actual Linux containers (Apple Container)` | `agents run in actual Docker containers` |
| `**Apple Container** for isolated agent execution (Linux VMs)` | `**Docker** for isolated agent execution (containers)` |
| `All agents run inside Apple Container (lightweight Linux VMs)` | `All agents run inside Docker containers` |
| `Runs on local Mac via launchd` | `Runs via systemd (Linux) or launchd (macOS)` |

Remove the `/convert-to-docker` entry from the RFS section (it's done!).

### `docs/SPEC.md` (if it exists)

Replace all `Apple Container` references with `Docker` equivalents.

## 5. Update Skills

Review all existing skills (in `.claude/skills/`) to ensure they work correctly with the Docker runtime. For each skill:

- Add Docker equivalents for any container CLI commands (`docker run`, `docker images`, `docker info`, `docker builder prune`, etc.)
- Add Docker mount syntax (`-v path:path:ro`) alongside any `--mount type=bind,...,readonly` examples
- Add Docker troubleshooting steps (e.g. `sudo systemctl start docker` on Linux, `open -a Docker` on macOS)
- Ensure diagnostic scripts and health checks detect Docker as a valid runtime
- Update architecture diagrams and documentation to reflect Docker support (e.g. `Host (macOS/Linux)`, `Container (Docker)`)
- Ensure shell scripts are Linux-compatible (e.g. `sed -i` without `''` on Linux vs `sed -i ''` on macOS)

## 6. Build and Verify

```bash
# Compile TypeScript — must succeed with no errors
npm run build

# Build Docker image
./container/build.sh

# Verify container runs
docker run --rm --entrypoint /bin/echo nanoclaw-agent:latest "OK"
```

## 7. Test the Migration

### Readonly mounts work:
```bash
mkdir -p /tmp/test-ro && echo "test" > /tmp/test-ro/file.txt
docker run --rm --entrypoint /bin/bash -v /tmp/test-ro:/test:ro nanoclaw-agent:latest \
  -c "cat /test/file.txt && touch /test/new.txt 2>&1 || echo 'Write blocked (expected)'"
rm -rf /tmp/test-ro
```

### Read-write mounts work:
```bash
mkdir -p /tmp/test-rw
docker run --rm --entrypoint /bin/bash -v /tmp/test-rw:/test nanoclaw-agent:latest \
  -c "echo 'test write' > /test/new.txt && cat /test/new.txt"
rm -rf /tmp/test-rw
```

### Full integration:
```bash
npm run dev
# Send a message via WhatsApp and verify response
```

## Summary of Changed Files

| File | Changes |
|------|---------|
| `src/container-runner.ts` | Mount syntax, `docker` spawn, `docker stop`, remove Apple Container comments |
| `src/index.ts` | `ensureDockerRunning()` with Docker orphan cleanup (newline-delimited JSON parsing) |
| `container/build.sh` | `docker build`, `docker run` |
| `CLAUDE.md` | Docker references, build cache, service management |
| `README.md` | Requirements, FAQ |
| `docs/REQUIREMENTS.md` | Architecture references, remove `/convert-to-docker` from RFS |
| `.claude/skills/*.md` | Add Docker runtime compatibility (commands, diagrams, troubleshooting) |
| `.claude/skills/setup/scripts/*.sh` | Ensure Linux compatibility (e.g. `sed -i` without `''`) |
