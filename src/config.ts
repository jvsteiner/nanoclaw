import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = process.env.STORE_DIR || path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = process.env.GROUPS_DIR || path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = process.env.DATA_DIR || path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// --- K8s / multi-tenant settings ---
export const K8S_ENV = process.env.K8S_ENV === 'true';
export const CONTAINER_RUNTIME_TYPE: 'docker' | 'k8s' =
  (process.env.CONTAINER_RUNTIME_TYPE as 'docker' | 'k8s') || 'docker';
export const K8S_NAMESPACE = process.env.K8S_NAMESPACE || 'default';
export const K8S_PVC_NAME = process.env.K8S_PVC_NAME || 'tenant-data';
export const AGENT_CPU_REQUEST = process.env.AGENT_CPU_REQUEST || '250m';
export const AGENT_CPU_LIMIT = process.env.AGENT_CPU_LIMIT || '1000m';
export const AGENT_MEMORY_REQUEST = process.env.AGENT_MEMORY_REQUEST || '512Mi';
export const AGENT_MEMORY_LIMIT = process.env.AGENT_MEMORY_LIMIT || '1Gi';
export const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '3000', 10);
export const TENANT_ID = process.env.TENANT_ID || '';
