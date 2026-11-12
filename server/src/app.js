import express from 'express';
import { mountAccount } from './account.js';
import { mountChats } from './chats.js';
import { HttpError } from './errors.js';
import { mountDrafts } from './guides/draft.js';
import { guideSummary, publicGuide } from './guides/store.js';
import { mountWallet, walletLinker } from './payments/routes.js';
import { createProgress, mountProgress, progressId } from './progress.js';
import { mountSite } from './site.js';
import { mountTimesheet } from './timesheet/routes.js';
import { sanitizeUserId } from './users.js';
import { mountVoice } from './voice.js';

export function createApp({ config, guides, docs, llm, users, assist, mcp, projects, activity, payments = null, topups = null, chats = null, logger = console }) {
  const app = express();
  const progress = createProgress();
  app.disable('x-powered-by');
  mountSite(app, { config }); // the download page and the app download, free and before x402
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => {
    req.userId = sanitizeUserId(req.get('x-goat-user'));
    next();
  });
  app.use(walletLinker({ config, users, payments }));
  // x402: POST /api/assist and POST /api/pro/upgrade need a payment (Pro users pay per assist too).
  if (payments) app.use(payments.middleware);

  app.get('/api/health', async (_req, res) => {
    const ollama = await llm.status(config.model);
    res.json({
      ok: true,
      models: { base: config.model, pro: config.modelPro, stt: config.sttModel },
      ollama: { host: config.ollamaHost, ...ollama },
      payments: { mode: config.payments, enforced: Boolean(payments), network: config.network, payTo: payments?.payTo ?? null },
      think: config.think,
      mcp: mcp ? mcp.status() : [],
      guides: guides.count(),
      docs: { files: docs.files, chunks: docs.count },
    });
  });

  app.get('/api/me', (req, res) => {
    const tier = users.tier(req.userId);
    res.json({
      id: req.userId,
      tier,
      pro: tier === 'pro',
      proUntil: users.get(req.userId).proUntil || null,
      model: tier === 'pro' ? config.modelPro : config.model,
    });
  });

  app.get('/api/guides', (_req, res) => {
    res.json({ guides: guides.list().map(guideSummary) });
  });

  app.get('/api/guides/:id', (req, res) => {
    const guide = guides.get(req.params.id);
    if (!guide) throw new HttpError(404, 'not_found', `There's no guide called "${req.params.id}".`);
    res.json(publicGuide(guide));
  });

  mountDrafts(app, { config, llm });

  app.post('/api/guides', (req, res) => {
    const guide = guides.save(req.body);
    logger.log(`[guides] Saved ${guide.id} (${guide.steps.length} steps)`);
    res.status(201).json(publicGuide(guide));
  });

  app.post('/api/assist', async (req, res) => {
    const { question, context, image, screen, voice, chatId, document, targets } = req.body || {};
    // chatId: continue that chat; null starts a new one; absent continues a fresh one.
    const chat = typeof chatId === 'string' || chatId === null ? chatId : undefined;
    // Steps for the overlay's readout while this ask runs.
    const run = progressId(req.get('x-goat-progress'));
    const onStep = run ? (text) => progress.step(run, text) : undefined;
    try {
      res.json(await assist({ question, context, image, screen, document, targets, voice: voice === true, tier: users.tier(req.userId), userId: req.userId, chatId: chat, onStep }));
    } finally {
      if (run) progress.done(run);
    }
  });

  if (projects && activity) mountTimesheet(app, { projects, activity, llm, config, logger });
  mountWallet(app, { config, users, payments, topups });
  mountVoice(app, { config, users, llm, projects });
  if (chats) mountChats(app, { chats });
  mountAccount(app, { config });
  mountProgress(app, { progress });

  app.use('/api', (req) => {
    throw new HttpError(404, 'not_found', `No route for ${req.method} ${req.originalUrl}.`);
  });

  // Every error leaves as JSON { error, message }.
  app.use((err, _req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    let code = err instanceof HttpError ? err.code : undefined;
    let message = err.message || 'Something went wrong.';
    if (err.type === 'entity.parse.failed') {
      code = 'bad_json';
      message = 'The request body is not valid JSON.';
    } else if (err.type === 'entity.too.large') {
      code = 'too_large';
      message = 'The request is too large.';
    } else if (!(err instanceof HttpError) && status >= 500) {
      logger.error('[server]', err);
      status = 500;
      message = 'Something went wrong on the GOAT server.';
    }
    code ||= status >= 500 ? 'internal_error' : 'bad_request';
    res.status(status).json({ error: code, message, ...(err instanceof HttpError ? err.extra : {}) });
  });

  return app;
}
