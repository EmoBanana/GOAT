import express from 'express';
import { HttpError } from './errors.js';
import { guideSummary, publicGuide } from './guides/store.js';
import { mountWallet, walletLinker } from './payments/routes.js';
import { mountTimesheet } from './timesheet/routes.js';
import { sanitizeUserId } from './users.js';

export function createApp({ config, guides, docs, llm, users, assist, mcp, projects, activity, payments = null, topups = null, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => {
    req.userId = sanitizeUserId(req.get('x-goat-user'));
    next();
  });
  app.use(walletLinker({ config, users, payments }));
  // x402: POST /api/assist and POST /api/pro/upgrade need a payment (Pro users ask free).
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

  app.post('/api/guides', (req, res) => {
    const guide = guides.save(req.body);
    logger.log(`[guides] Saved ${guide.id} (${guide.steps.length} steps)`);
    res.status(201).json(publicGuide(guide));
  });

  app.post('/api/assist', async (req, res) => {
    const { question, context, image } = req.body || {};
    res.json(await assist({ question, context, image, tier: users.tier(req.userId), userId: req.userId }));
  });

  if (projects && activity) mountTimesheet(app, { projects, activity });
  mountWallet(app, { config, users, payments, topups });

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
