/**
 * Container runtime abstraction for NanoClaw.
 * Provides a common interface for Docker and K8s container execution.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough, Readable } from 'stream';

import {
  CONTAINER_RUNTIME_TYPE,
  K8S_NAMESPACE,
  K8S_PVC_NAME,
  AGENT_CPU_REQUEST,
  AGENT_CPU_LIMIT,
  AGENT_MEMORY_REQUEST,
  AGENT_MEMORY_LIMIT,
} from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Container process abstraction
// ---------------------------------------------------------------------------

export interface ContainerProcess extends EventEmitter {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly name: string;
  readonly killed: boolean;
  kill(signal?: string): void;
}

// ---------------------------------------------------------------------------
// Container runtime interface
// ---------------------------------------------------------------------------

export interface RuntimeRunOptions {
  containerName: string;
  image: string;
  args: string[];
  env: Record<string, string>;
  input: string;
  groupFolder?: string;
  isMain?: boolean;
}

export interface ContainerRuntime {
  run(opts: RuntimeRunOptions): Promise<ContainerProcess>;
  stop(name: string): void;
  ensureRunning(): void;
  cleanup(): void;
}

// ---------------------------------------------------------------------------
// Docker runtime (existing behavior, wrapped in a class)
// ---------------------------------------------------------------------------

export const CONTAINER_RUNTIME_BIN = 'docker';

export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

class DockerContainerProcess extends EventEmitter implements ContainerProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly name: string;
  private proc: ChildProcess;

  constructor(proc: ChildProcess, name: string) {
    super();
    this.proc = proc;
    this.name = name;
    this.stdout = proc.stdout!;
    this.stderr = proc.stderr!;
    proc.on('close', (code) => this.emit('close', code));
    proc.on('error', (err) => this.emit('error', err));
  }

  get killed(): boolean {
    return this.proc.killed;
  }

  kill(signal?: string): void {
    this.proc.kill(signal as NodeJS.Signals);
  }
}

export class DockerContainerRuntime implements ContainerRuntime {
  async run(opts: RuntimeRunOptions): Promise<ContainerProcess> {
    const proc = spawn(CONTAINER_RUNTIME_BIN, opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const cp = new DockerContainerProcess(proc, opts.containerName);

    // Write input to stdin
    proc.stdin!.write(opts.input);
    proc.stdin!.end();

    return cp;
  }

  stop(name: string): void {
    try {
      execSync(stopContainer(name), { stdio: 'pipe', timeout: 15000 });
    } catch {
      /* already stopped */
    }
  }

  ensureRunning(): void {
    ensureContainerRuntimeRunning();
  }

  cleanup(): void {
    cleanupOrphans();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createRuntime(): Promise<ContainerRuntime> {
  if (CONTAINER_RUNTIME_TYPE === 'k8s') {
    // Dynamic import to avoid loading @kubernetes/client-node when not needed
    const { K8sContainerRuntime } = await import('./k8s-runtime.js');
    return new K8sContainerRuntime({
      namespace: K8S_NAMESPACE,
      pvcName: K8S_PVC_NAME,
      resources: {
        requests: { cpu: AGENT_CPU_REQUEST, memory: AGENT_MEMORY_REQUEST },
        limits: { cpu: AGENT_CPU_LIMIT, memory: AGENT_MEMORY_LIMIT },
      },
    });
  }
  return new DockerContainerRuntime();
}
