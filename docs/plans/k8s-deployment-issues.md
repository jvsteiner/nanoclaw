# K8s Deployment Issues and Fixes

Tracking document for all issues found during the Docker-to-K8s migration.
Each issue includes the root cause, the fix applied, and whether it's been
permanently resolved or needs further work.

## Resolved

### 1. ESM dynamic import (`require` in ESM module)

- **Symptom:** `ReferenceError: require is not defined`
- **Root cause:** `createRuntime()` in `container-runtime.ts` used `require()` for lazy-loading `k8s-runtime.ts`, but the project is `"type": "module"`.
- **Fix:** Changed to `async function createRuntime()` with `await import('./k8s-runtime.js')`. Updated caller in `index.ts` to `await createRuntime()`.
- **Status:** Fixed in code.

### 2. Native addon missing (`better-sqlite3`)

- **Symptom:** `Could not locate the bindings file` for better-sqlite3
- **Root cause:** `Dockerfile` used `--ignore-scripts` on `npm ci` in the production stage, which skips the native compilation step for `better-sqlite3`.
- **Fix:** Added `python3 make g++` to production stage, then `npm rebuild better-sqlite3` after install, then purge build tools.
- **Status:** Fixed in Dockerfile.

### 3. PodSecurity policy blocks agent Jobs

- **Symptom:** `violates PodSecurity "restricted:latest"` — pods never created
- **Root cause:** K8s runtime Job spec was missing container-level `securityContext` fields required by the `restricted` PodSecurity Standard: `allowPrivilegeEscalation`, `capabilities.drop`, `seccompProfile`.
- **Fix:** Added full security context to both pod and container specs in `k8s-runtime.ts`.
- **Status:** Fixed in code.

### 4. Private GHCR images can't be pulled by agent Jobs

- **Symptom:** Agent Jobs timeout waiting for pod — `ErrImagePull`
- **Root cause:** GHCR packages default to private. The orchestrator StatefulSet had `imagePullSecrets` patched in, but agent Jobs created by `k8s-runtime.ts` didn't include them.
- **Fix:** Added `K8S_IMAGE_PULL_SECRET` env var support to `k8s-runtime.ts`. When set, agent Job specs include `imagePullSecrets`. Added to Helm chart ConfigMap as well.
- **Permanent fix needed:** Either make GHCR packages public, or add the pull secret creation to the Helm chart templates so it's declarative. Currently the `ghcr-creds` secret was created manually and depends on a `gh auth token` that expires.

### 5. Secrets not passed to agent container in K8s mode

- **Symptom:** Agent responds "Not logged in - Please run /login"
- **Root cause:** `readSecrets()` in `container-runner.ts` only reads from `.env` file via `readEnvFile()`. In K8s, the Anthropic API key is injected as a `process.env` variable from a K8s Secret, not from a `.env` file.
- **Fix:** `readSecrets()` now falls back to `process.env` for any key not found in `.env`.
- **Status:** Fixed in code.

### 6. No messaging channel installed

- **Symptom:** `No channels connected` — orchestrator exits
- **Root cause:** Nanoclaw uses a skill-based channel system. The `src/channels/index.ts` barrel had all imports commented out. No channel code was compiled into the Docker image.
- **Fix:** Copied Telegram channel implementation from nestor, adapted for nanoclaw's registry pattern, added barrel import.
- **Permanent fix needed:** Channels should be installable at deploy time or via config, not baked into the source. For now, Telegram is hardcoded.

## Needs Further Work

### 7. Image pull secret lifecycle

The `ghcr-creds` secret is created manually with a `gh auth token` that expires.
Options:
- Make GHCR packages public (simplest)
- Create a long-lived GitHub PAT with `read:packages` scope
- Add secret creation to Helm chart with a values parameter for the token
- Use a k8s CronJob or external-secrets-operator to rotate

### 8. Group bootstrapping

There's no API or CLI to register the initial main group. We had to `kubectl exec`
into the pod and INSERT directly into SQLite. Options:
- Add a `/register` HTTP endpoint to the health server
- Add a CLI flag or env var for initial group registration
- Add an init container or startup script that seeds the DB

### 9. Build/push workflow

Currently manual `docker buildx` + `docker push`. Needs:
- GitHub Actions CI/CD pipeline
- Tag images with git SHA, not just `latest`
- Multi-arch builds if needed (currently arm64 only)

### 10. Helm chart `imagePullSecrets` not wired to StatefulSet/Jobs declaratively

The orchestrator StatefulSet was patched ad-hoc. The Helm chart should:
- Accept an `imagePullSecret` value
- Optionally create the docker-registry Secret from a token value
- Wire it into both the StatefulSet and (via ConfigMap env var) agent Jobs
