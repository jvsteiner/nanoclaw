/**
 * Health, readiness, and Prometheus metrics endpoints for K8s probes.
 * Uses Node built-in http module to avoid adding dependencies.
 */
import http from 'http';

import { HEALTH_PORT } from './config.js';
import { logger } from './logger.js';

export interface HealthDependencies {
  getActiveConversations: () => number;
  isReady: () => boolean;
}

let messagesTotal = 0;
let agentExecutionsTotal = 0;

export function incrementMessages(): void {
  messagesTotal++;
}

export function incrementAgentExecutions(): void {
  agentExecutionsTotal++;
}

export function startHealthServer(deps: HealthDependencies): http.Server {
  const startTime = Date.now();

  const server = http.createServer((req, res) => {
    const url = req.url?.split('?')[0];

    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }

    if (url === '/health' || url === '/healthz') {
      const mem = process.memoryUsage();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
        activeConversations: deps.getActiveConversations(),
      }));
      return;
    }

    if (url === '/ready' || url === '/readyz') {
      if (deps.isReady()) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: true }));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: false }));
      }
      return;
    }

    if (url === '/metrics') {
      const mem = process.memoryUsage();
      const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
      const lines = [
        '# HELP nanoclaw_messages_total Total messages processed',
        '# TYPE nanoclaw_messages_total counter',
        `nanoclaw_messages_total ${messagesTotal}`,
        '',
        '# HELP nanoclaw_active_conversations Current active conversations',
        '# TYPE nanoclaw_active_conversations gauge',
        `nanoclaw_active_conversations ${deps.getActiveConversations()}`,
        '',
        '# HELP nanoclaw_agent_executions_total Total agent executions',
        '# TYPE nanoclaw_agent_executions_total counter',
        `nanoclaw_agent_executions_total ${agentExecutionsTotal}`,
        '',
        '# HELP nanoclaw_memory_bytes Process memory in bytes',
        '# TYPE nanoclaw_memory_bytes gauge',
        `nanoclaw_memory_bytes{type="rss"} ${mem.rss}`,
        `nanoclaw_memory_bytes{type="heap_used"} ${mem.heapUsed}`,
        `nanoclaw_memory_bytes{type="heap_total"} ${mem.heapTotal}`,
        '',
        '# HELP nanoclaw_uptime_seconds Orchestrator uptime',
        '# TYPE nanoclaw_uptime_seconds gauge',
        `nanoclaw_uptime_seconds ${uptimeSeconds}`,
        '',
      ];
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(lines.join('\n'));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(HEALTH_PORT, () => {
    logger.info({ port: HEALTH_PORT }, 'Health server started');
  });

  return server;
}
