/**
 * K8s container runtime for NanoClaw.
 * Spawns agent containers as K8s Jobs and follows pod logs.
 */
import { EventEmitter } from 'events';
import { PassThrough, Readable } from 'stream';

import * as k8s from '@kubernetes/client-node';

import type {
  ContainerProcess,
  ContainerRuntime,
  RuntimeRunOptions,
} from './container-runtime.js';
import { logger } from './logger.js';

export interface K8sRuntimeOptions {
  namespace: string;
  pvcName: string;
  kubeconfig?: string;
  pollIntervalMs?: number;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
}

export class K8sContainerRuntime implements ContainerRuntime {
  private batchApi: k8s.BatchV1Api;
  private coreApi: k8s.CoreV1Api;
  private logApi: k8s.Log;
  private namespace: string;
  private pvcName: string;
  private pollIntervalMs: number;
  private resources: K8sRuntimeOptions['resources'];

  constructor(options: K8sRuntimeOptions) {
    const kc = new k8s.KubeConfig();
    if (options.kubeconfig) {
      kc.loadFromFile(options.kubeconfig);
    } else if (process.env.KUBERNETES_SERVICE_HOST) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }

    this.batchApi = kc.makeApiClient(k8s.BatchV1Api);
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.logApi = new k8s.Log(kc);
    this.namespace = options.namespace;
    this.pvcName = options.pvcName;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.resources = options.resources;
  }

  async run(opts: RuntimeRunOptions): Promise<ContainerProcess> {
    const imagePullSecret = globalThis.process.env.K8S_IMAGE_PULL_SECRET;
    const jobName = this.sanitizeName(opts.containerName);

    // Encode input as base64 env var (K8s Jobs don't support stdin)
    const inputB64 = Buffer.from(opts.input).toString('base64');

    const envVars: k8s.V1EnvVar[] = [
      ...Object.entries(opts.env).map(([name, value]) => ({ name, value })),
      { name: 'NANOCLAW_INPUT_B64', value: inputB64 },
      { name: 'NANOCLAW_K8S_MODE', value: 'true' },
    ];

    // Build volume mounts from the PVC with subPaths
    const volumes: k8s.V1Volume[] = [
      {
        name: 'tenant-data',
        persistentVolumeClaim: { claimName: this.pvcName },
      },
    ];

    const gf = opts.groupFolder ?? 'default';
    // subPaths must match the orchestrator's directory layout on the PVC:
    // groups/ is at PVC root, ipc/ and sessions/ are under data/
    const volumeMounts: k8s.V1VolumeMount[] = [
      {
        name: 'tenant-data',
        mountPath: '/workspace/group',
        subPath: `groups/${gf}`,
      },
      {
        name: 'tenant-data',
        mountPath: '/workspace/ipc',
        subPath: `data/ipc/${gf}`,
      },
      {
        name: 'tenant-data',
        mountPath: '/home/node/.claude',
        subPath: `data/sessions/${gf}/.claude`,
      },
      {
        name: 'tenant-data',
        mountPath: '/app/src',
        subPath: `data/sessions/${gf}/agent-runner-src`,
      },
    ];

    const job: k8s.V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'nanoclaw',
          'nanoclaw/role': 'agent',
          'nanoclaw/job': jobName,
        },
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 300,
        template: {
          metadata: {
            labels: {
              'app.kubernetes.io/managed-by': 'nanoclaw',
              'nanoclaw/role': 'agent',
              'nanoclaw/job': jobName,
            },
          },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: 'nanoclaw-agent',
            automountServiceAccountToken: false,
            ...(imagePullSecret
              ? { imagePullSecrets: [{ name: imagePullSecret }] }
              : {}),
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'agent',
                image: opts.image,
                env: envVars,
                volumeMounts,
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'] },
                  seccompProfile: { type: 'RuntimeDefault' },
                },
                resources: {
                  requests: {
                    cpu: this.resources?.requests?.cpu ?? '250m',
                    memory: this.resources?.requests?.memory ?? '512Mi',
                  },
                  limits: {
                    cpu: this.resources?.limits?.cpu ?? '1000m',
                    memory: this.resources?.limits?.memory ?? '1Gi',
                  },
                },
              },
            ],
            volumes,
          },
        },
      },
    };

    await this.batchApi.createNamespacedJob({
      namespace: this.namespace,
      body: job,
    });
    logger.info({ jobName, namespace: this.namespace }, 'K8s Job created');

    // Wait for pod to start, then follow logs
    const process = new K8sContainerProcess(jobName);
    this.followJobLifecycle(jobName, process).catch((err) => {
      logger.error({ jobName, err }, 'Error following Job lifecycle');
      process.emitClose(1);
    });

    return process;
  }

  stop(name: string): void {
    const jobName = this.sanitizeName(name);
    this.batchApi
      .deleteNamespacedJob({
        name: jobName,
        namespace: this.namespace,
        body: { propagationPolicy: 'Background' },
      })
      .catch((err) => {
        const status = (err as { response?: { statusCode?: number } })?.response
          ?.statusCode;
        if (status !== 404) {
          logger.warn({ jobName, err }, 'Failed to delete Job');
        }
      });
  }

  ensureRunning(): void {
    // K8s API is always available when running in-cluster
    logger.info({ namespace: this.namespace }, 'K8s container runtime ready');
  }

  cleanup(): void {
    this.batchApi
      .listNamespacedJob({
        namespace: this.namespace,
        labelSelector:
          'app.kubernetes.io/managed-by=nanoclaw,nanoclaw/role=agent',
      })
      .then((response) => {
        const orphans = (response.items ?? []).filter((job) => {
          const active = (job.status?.active ?? 0) > 0;
          const age =
            Date.now() -
            (job.metadata?.creationTimestamp?.getTime() ?? Date.now());
          return active && age > 3600000; // > 1 hour old
        });
        for (const job of orphans) {
          this.stop(job.metadata!.name!);
        }
        if (orphans.length > 0) {
          logger.info(
            { count: orphans.length },
            'Cleaned up orphaned K8s Jobs',
          );
        }
      })
      .catch((err) => {
        logger.warn({ err }, 'Failed to cleanup orphaned K8s Jobs');
      });
  }

  private async followJobLifecycle(
    jobName: string,
    proc: K8sContainerProcess,
  ): Promise<void> {
    // Wait for pod to appear and start
    const podName = await this.waitForPod(jobName);
    if (!podName) {
      proc.emitClose(1);
      return;
    }

    // Follow pod logs and pipe to stdout PassThrough
    try {
      const logStream = new PassThrough();
      logStream.on('data', (chunk) => {
        proc.pushStdout(chunk);
      });

      await this.logApi.log(this.namespace, podName, 'agent', logStream, {
        follow: true,
        pretty: false,
      });
    } catch (err) {
      logger.debug({ jobName, err }, 'Log follow ended');
    }

    // Wait for Job completion
    const exitCode = await this.waitForCompletion(jobName);
    proc.emitClose(exitCode);
  }

  private async waitForPod(jobName: string): Promise<string | null> {
    const deadline = Date.now() + 120000; // 2 min to schedule
    while (Date.now() < deadline) {
      try {
        const pods = await this.coreApi.listNamespacedPod({
          namespace: this.namespace,
          labelSelector: `nanoclaw/job=${jobName}`,
        });
        const pod = pods.items?.[0];
        if (pod?.metadata?.name) {
          const phase = pod.status?.phase;
          if (
            phase === 'Running' ||
            phase === 'Succeeded' ||
            phase === 'Failed'
          ) {
            return pod.metadata.name;
          }
        }
      } catch (err) {
        logger.debug({ jobName, err }, 'Error listing pods');
      }
      await sleep(this.pollIntervalMs);
    }
    logger.error({ jobName }, 'Timed out waiting for pod to start');
    return null;
  }

  private async waitForCompletion(jobName: string): Promise<number> {
    const deadline = Date.now() + 3600000; // 1 hour max
    while (Date.now() < deadline) {
      try {
        const job = await this.batchApi.readNamespacedJob({
          name: jobName,
          namespace: this.namespace,
        });
        if ((job.status?.succeeded ?? 0) > 0) return 0;
        if ((job.status?.failed ?? 0) > 0) return 1;
      } catch (err) {
        const status = (err as { response?: { statusCode?: number } })?.response
          ?.statusCode;
        if (status === 404) return 1; // Job was deleted
        logger.debug({ jobName, err }, 'Error reading Job status');
      }
      await sleep(this.pollIntervalMs);
    }
    return 124; // timeout
  }

  private sanitizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 63);
  }
}

class K8sContainerProcess extends EventEmitter implements ContainerProcess {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly name: string;
  private _killed = false;

  constructor(name: string) {
    super();
    this.name = name;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  get killed(): boolean {
    return this._killed;
  }

  kill(_signal?: string): void {
    this._killed = true;
  }

  pushStdout(data: Buffer | string): void {
    this.stdout.push(data);
  }

  emitClose(code: number): void {
    this._killed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
