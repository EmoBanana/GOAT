import http from 'node:http';
import { createApp } from './app.js';
import { createAssist } from './assist.js';
import { createDocs } from './docs.js';
import { createGuideStore } from './guides/store.js';
import { createOllama } from './llm/ollama.js';
import { createMcpHub } from './mcp/hub.js';
import { createActivityStore } from './timesheet/activity.js';
import { loadProjects } from './timesheet/projects.js';
import { createUsers } from './users.js';

// Wires the dependencies. Tests pass overrides (mock LLM, quiet logger, temp dirs).
export async function buildServer(config, overrides = {}) {
  const logger = overrides.logger ?? console;
  const guides = overrides.guides ?? createGuideStore({ dir: config.guidesDir, logger });
  const docs = overrides.docs ?? createDocs({ dir: config.docsDir });
  const llm =
    overrides.llm ?? createOllama({ host: config.ollamaHost, keepAlive: config.keepAlive, timeoutMs: config.llmTimeoutMs });
  const users = overrides.users ?? createUsers({ dataDir: config.dataDir, logger });
  const mcp = overrides.mcp ?? createMcpHub({ file: config.mcpConfig, env: process.env, logger });
  const assist = overrides.assist ?? createAssist({ config, guides, docs, llm, mcp });
  const projects = overrides.projects ?? loadProjects(config.projectsFile);
  const activity = overrides.activity ?? createActivityStore({ dataDir: config.dataDir });
  const app = createApp({ config, guides, docs, llm, users, assist, mcp, projects, activity, logger });
  return { app, config, guides, docs, llm, users, mcp, assist, projects, activity };
}

export function listen(app, { port, host }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
