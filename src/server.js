import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initDatabase,
  getDatabase,
  getAllRepositories,
  getRepositoryById,
  addRepository,
  updateRepository,
  deleteRepository,
  getRecentProcessedEvents,
  getSetting,
  setSetting,
  getAllSettings,
  getQueueStatus,
  retryDeliveryItem,
  retryAllDeadLetters
} from './db/database.js';
import {
  GitHubService,
  PrivateRepositoryError,
  RepositoryNotFoundError
} from './services/github.js';
import { EventNormalizer } from './services/normalizer.js';
import { EventPipeline } from './services/deduplicator.js';
import { DiscordService } from './services/discord.js';
import { PollingScheduler } from './services/scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createServer(options = {}) {
  const app = express();

  // Raw body capture for webhook signature verification
  app.use(express.json({
    limit: '5mb',
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    }
  }));

  // Initialize DB if not provided
  if (!options.skipDbInit) {
    initDatabase(options.dbPath);
  }

  // Load configured credentials or environment variables
  let initialWebhooks = [];
  const storedWebhooksJson = getSetting('discord_webhooks');
  if (storedWebhooksJson) {
    try {
      initialWebhooks = JSON.parse(storedWebhooksJson);
    } catch {
      initialWebhooks = [];
    }
  }

  // Fallback to legacy single setting or env variable
  if (initialWebhooks.length === 0) {
    const legacyUrl = getSetting('discord_webhook_url') || process.env.DISCORD_WEBHOOK_URL || '';
    if (legacyUrl) {
      const splitUrls = legacyUrl.split(/[\n,]+/).map(u => u.trim()).filter(Boolean);
      initialWebhooks = splitUrls.map((url, i) => ({
        id: `wh_${Date.now()}_${i}`,
        name: splitUrls.length > 1 ? `Channel ${i + 1}` : 'General Alerts',
        url,
        enabled: true
      }));
    }
  }

  const githubToken = getSetting('github_token') || process.env.GITHUB_TOKEN || '';
  const webhookSecret = getSetting('github_webhook_secret') || process.env.GITHUB_WEBHOOK_SECRET || '';
  const githubOwner = getSetting('github_owner') || process.env.GITHUB_OWNER || '';
  const adminApiKey = getSetting('admin_api_key') || process.env.ADMIN_API_KEY || '';

  const githubService = options.githubService || new GitHubService({ token: githubToken });
  const discordService = options.discordService || new DiscordService({ webhooks: initialWebhooks, mockMode: initialWebhooks.length === 0 });
  const pipeline = options.pipeline || new EventPipeline({ discordService });
  const scheduler = options.scheduler || new PollingScheduler({ githubService, pipeline });

  // Expose services on app for tests
  app.locals.githubService = githubService;
  app.locals.discordService = discordService;
  app.locals.pipeline = pipeline;
  app.locals.scheduler = scheduler;

  // Serve static files
  const publicDir = path.resolve(__dirname, '../public');
  app.use(express.static(publicDir));

  // -----------------------------------------------------------
  // Health & Readiness Endpoints (Docker & Monitoring)
  // -----------------------------------------------------------

  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'GitHub Discord Bot',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  });

  app.get('/ready', (req, res) => {
    try {
      const db = getDatabase();
      const test = db.prepare('SELECT 1 as alive').get();
      if (test && test.alive === 1) {
        return res.status(200).json({
          ready: true,
          database: 'connected',
          timestamp: new Date().toISOString()
        });
      }
      res.status(503).json({ ready: false, database: 'unhealthy' });
    } catch (err) {
      res.status(503).json({ ready: false, error: err.message });
    }
  });

  // -----------------------------------------------------------
  // GitHub App Webhook Listener (Durable Outbox Ingestion)
  // -----------------------------------------------------------

  app.post('/api/webhooks/github', async (req, res) => {
    const eventName = req.headers['x-github-event'];
    const signature = req.headers['x-hub-signature-256'];
    const deliveryId = req.headers['x-github-delivery'];

    if (!eventName) {
      return res.status(400).send('Missing X-GitHub-Event header.');
    }

    // Ping event
    if (eventName === 'ping') {
      return res.status(200).json({ message: 'Pong! GitHub Discord Bot webhook endpoint active.' });
    }

    // Verify HMAC if configured
    const currentSecret = getSetting('github_webhook_secret') || process.env.GITHUB_WEBHOOK_SECRET;
    if (currentSecret) {
      const isValid = EventNormalizer.verifyWebhookSignature(req.rawBody || JSON.stringify(req.body), signature, currentSecret);
      if (!isValid) {
        return res.status(401).send('Invalid webhook signature.');
      }
    }

    try {
      const normalized = EventNormalizer.normalizeWebhook(eventName, req.body);
      if (!normalized) {
        return res.status(200).json({ message: `Ignored event type: ${eventName}` });
      }

      // Append deliveryId if available
      if (deliveryId) {
        normalized.deliveryId = deliveryId;
      }

      // Durable acceptance into SQLite outbox
      const outcome = await pipeline.processEvent(normalized, false);

      if (outcome.deduplicated) {
        return res.status(200).json({ success: true, message: 'Event already processed (deduplicated).' });
      }

      if (outcome.filteredOut) {
        return res.status(200).json({ success: true, message: outcome.message || 'Filtered out by preferences.' });
      }

      // 202 Accepted after durable acceptance into database
      res.status(202).json({
        success: true,
        enqueued: true,
        queueId: outcome.queueId,
        message: 'Event accepted and queued for delivery.'
      });
    } catch (err) {
      console.error('[Webhook] Ingestion error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------
  // Repositories API
  // -----------------------------------------------------------

  app.get('/api/repositories', (req, res) => {
    try {
      const type = req.query.type;
      let filter = {};
      if (type === 'owned') {
        filter.is_owned = true;
      } else if (type === 'watched') {
        filter.is_owned = false;
      }
      const repos = getAllRepositories(filter);
      res.json({ success: true, repositories: repos });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/repositories', async (req, res) => {
    try {
      const { input, is_owned, preferences, polling_interval_seconds, verifyOnly } = req.body;
      if (!input) {
        return res.status(400).json({ success: false, error: 'Repository URL or owner/repo identifier is required.' });
      }

      const { owner, name, fullName } = GitHubService.parseRepoInput(input);

      let verified;
      try {
        verified = await githubService.verifyRepository(owner, name);
      } catch (err) {
        if (err instanceof PrivateRepositoryError) {
          return res.status(400).json({
            success: false,
            error: err.message,
            code: 'PRIVATE_REPOSITORY_REJECTED'
          });
        }
        if (err instanceof RepositoryNotFoundError) {
          return res.status(404).json({
            success: false,
            error: err.message,
            code: 'REPOSITORY_NOT_FOUND'
          });
        }
        return res.status(err.statusCode || 500).json({ success: false, error: err.message });
      }

      if (verifyOnly) {
        return res.json({ success: true, repository: verified });
      }

      const isOwned = Boolean(is_owned);
      const monitoringType = isOwned ? 'webhook' : 'polling';

      const newRepo = addRepository({
        github_id: verified.id,
        owner: verified.owner,
        name: verified.name,
        full_name: verified.fullName,
        is_owned: isOwned,
        monitoring_type: monitoringType,
        enabled: true,
        polling_interval_seconds: polling_interval_seconds || 300,
        health_status: 'healthy',
        health_message: isOwned 
          ? 'Registered for GitHub App webhooks' 
          : 'Monitored via public API polling adapter',
        preferences
      });

      res.status(201).json({
        success: true,
        message: `Successfully added ${verified.fullName} to ${isOwned ? 'My Repositories' : 'Watched Repositories'}.`,
        repository: newRepo
      });

      // Asynchronously establish baseline checkpoint for watched repository
      if (!isOwned && scheduler) {
        scheduler.pollRepository(newRepo).catch(err => {
          console.warn(`[Scheduler] Initial baseline poll for ${newRepo.full_name}:`, err.message);
        });
      }
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        return res.status(409).json({ success: false, error: 'Repository is already being monitored.' });
      }
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/repositories/:id/toggle', (req, res) => {
    try {
      const repo = getRepositoryById(req.params.id);
      if (!repo) {
        return res.status(404).json({ success: false, error: 'Repository not found.' });
      }
      const updated = updateRepository(repo.id, { enabled: !repo.enabled });
      res.json({ success: true, repository: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/repositories/:id/preferences', (req, res) => {
    try {
      const repo = getRepositoryById(req.params.id);
      if (!repo) {
        return res.status(404).json({ success: false, error: 'Repository not found.' });
      }
      const updated = updateRepository(repo.id, { preferences: req.body });
      res.json({ success: true, repository: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/repositories/:id/interval', (req, res) => {
    try {
      const repo = getRepositoryById(req.params.id);
      if (!repo) {
        return res.status(404).json({ success: false, error: 'Repository not found.' });
      }
      const intervalSec = parseInt(req.body.polling_interval_seconds, 10);
      if (isNaN(intervalSec) || intervalSec < 30) {
        return res.status(400).json({ success: false, error: 'Polling interval must be at least 30 seconds.' });
      }
      const updated = updateRepository(repo.id, { polling_interval_seconds: intervalSec });
      res.json({ success: true, repository: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/repositories/:id', (req, res) => {
    try {
      const deleted = deleteRepository(req.params.id);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Repository not found.' });
      }
      res.json({ success: true, message: 'Repository removed from watchlist.' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/repositories/:id/poll', async (req, res) => {
    try {
      const result = await scheduler.pollRepositoryNow(req.params.id);
      res.json({ success: true, result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/discover', async (req, res) => {
    try {
      const result = await scheduler.runDiscoveryCycle();
      res.json({ success: true, result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/events', (req, res) => {
    try {
      const limit = parseInt(req.query.limit, 10) || 50;
      const events = getRecentProcessedEvents(limit);
      res.json({ success: true, events });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------
  // Admin & Outbox Queue Operations
  // -----------------------------------------------------------

  const authMiddleware = (req, res, next) => {
    const adminKey = getSetting('admin_api_key') || process.env.ADMIN_API_KEY;
    if (adminKey) {
      const provided = req.headers['x-api-key'] || req.query.api_key;
      if (provided !== adminKey) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Admin API Key.' });
      }
    }
    next();
  };

  app.get('/api/admin/queue', authMiddleware, (req, res) => {
    try {
      const status = getQueueStatus();
      res.json({ success: true, queue: status });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/admin/queue/:id/retry', authMiddleware, (req, res) => {
    try {
      const success = retryDeliveryItem(req.params.id);
      res.json({ success, message: success ? 'Item re-enqueued.' : 'Item not found.' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/admin/queue/retry-all-dead', authMiddleware, (req, res) => {
    try {
      const count = retryAllDeadLetters();
      res.json({ success: true, count, message: `Re-enqueued ${count} dead-letter items.` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------
  // System Status & Settings
  // -----------------------------------------------------------

  app.get('/api/status', async (req, res) => {
    try {
      const allRepos = getAllRepositories();
      const owned = allRepos.filter(r => r.is_owned);
      const watched = allRepos.filter(r => !r.is_owned);
      const active = allRepos.filter(r => r.enabled);

      const rateLimit = await githubService.getRateLimitStatus();
      const activeWebhooks = discordService.getActiveWebhooks();
      const discordConfigured = activeWebhooks.length > 0;
      const queueStatus = getQueueStatus();

      res.json({
        success: true,
        summary: {
          total: allRepos.length,
          ownedCount: owned.length,
          watchedCount: watched.length,
          activeCount: active.length,
          discordConfigured,
          discordWebhooksCount: activeWebhooks.length,
          rateLimit,
          queue: queueStatus,
          githubOwner: getSetting('github_owner') || process.env.GITHUB_OWNER || ''
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/settings', (req, res) => {
    const settings = getAllSettings();
    const webhooks = discordService.getAllWebhooks();
    res.json({
      success: true,
      settings: {
        discord_webhooks: webhooks,
        has_discord: discordService.getActiveWebhooks().length > 0,
        github_owner: settings.github_owner || process.env.GITHUB_OWNER || '',
        github_token: settings.github_token ? '••••••••' + settings.github_token.slice(-4) : (process.env.GITHUB_TOKEN ? '••••••••' : ''),
        has_token: Boolean(settings.github_token || process.env.GITHUB_TOKEN),
        github_webhook_secret: settings.github_webhook_secret ? '••••••••' + settings.github_webhook_secret.slice(-4) : (process.env.GITHUB_WEBHOOK_SECRET ? '••••••••' : ''),
        has_webhook_secret: Boolean(settings.github_webhook_secret || process.env.GITHUB_WEBHOOK_SECRET),
        admin_api_key: settings.admin_api_key ? '••••••••' : (process.env.ADMIN_API_KEY ? '••••••••' : ''),
        has_admin_api_key: Boolean(settings.admin_api_key || process.env.ADMIN_API_KEY),
        default_polling_interval: settings.default_polling_interval || process.env.DEFAULT_POLLING_INTERVAL || '300'
      }
    });
  });

  app.post('/api/settings', (req, res) => {
    try {
      const {
        discord_webhooks,
        discord_webhook_url,
        github_owner,
        github_token,
        github_webhook_secret,
        admin_api_key,
        default_polling_interval
      } = req.body;

      if (discord_webhooks !== undefined) {
        discordService.setWebhooks(discord_webhooks);
        setSetting('discord_webhooks', JSON.stringify(discordService.getAllWebhooks()));
        if (discordService.webhookUrl) {
          setSetting('discord_webhook_url', discordService.webhookUrl);
        }
        discordService.setMockMode(discordService.getActiveWebhooks().length === 0);
      } else if (discord_webhook_url !== undefined && !discord_webhook_url.startsWith('••••')) {
        setSetting('discord_webhook_url', discord_webhook_url);
        discordService.setWebhookUrl(discord_webhook_url);
        setSetting('discord_webhooks', JSON.stringify(discordService.getAllWebhooks()));
        discordService.setMockMode(!discord_webhook_url);
      }

      if (github_owner !== undefined) {
        setSetting('github_owner', github_owner.trim());
      }

      if (github_token !== undefined && !github_token.startsWith('••••')) {
        setSetting('github_token', github_token.trim());
        githubService.setToken(github_token.trim());
      }

      if (github_webhook_secret !== undefined && !github_webhook_secret.startsWith('••••')) {
        setSetting('github_webhook_secret', github_webhook_secret.trim());
      }

      if (admin_api_key !== undefined && !admin_api_key.startsWith('••••')) {
        setSetting('admin_api_key', admin_api_key.trim());
        process.env.ADMIN_API_KEY = admin_api_key.trim();
      }

      if (default_polling_interval !== undefined) {
        setSetting('default_polling_interval', String(default_polling_interval));
      }

      res.json({
        success: true,
        message: 'Settings saved successfully.',
        settings: {
          has_token: Boolean(getSetting('github_token') || process.env.GITHUB_TOKEN),
          has_discord: discordService.getActiveWebhooks().length > 0,
          github_owner: getSetting('github_owner') || process.env.GITHUB_OWNER || ''
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/settings/discord-test', async (req, res) => {
    try {
      const url = req.body.url;
      const masked = url ? url.replace(/webhooks\/(\d+)\/([A-Za-z0-9_-]+)/, 'webhooks/$1/****') : 'default';
      console.log(`[Discord Test] Testing webhook URL: ${masked}`);

      const result = await discordService.sendTestNotification(url);
      if (result && result.success === false) {
        console.error(`[Discord Test] Delivery failed:`, result.error);
        return res.status(400).json({ success: false, error: result.error || 'Discord webhook test failed.' });
      }
      console.log(`[Discord Test] Successfully delivered test notification.`);
      res.json({ success: true, message: 'Discord test notification sent successfully!', result });
    } catch (err) {
      console.error(`[Discord Test] Error:`, err.message);
      res.status(400).json({ success: false, error: err.message });
    }
  });

  return { app, scheduler, githubService, discordService, pipeline };
}

// Start standalone server if run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = process.env.PORT || 3000;
  const { app, scheduler, pipeline } = createServer();
  scheduler.start();
  pipeline.startQueueProcessor();

  const server = app.listen(PORT, () => {
    console.log(`\n🚀 GitHub Discord Bot Server running at http://0.0.0.0:${PORT}`);
    console.log(`📡 GitHub Webhook Endpoint: http://0.0.0.0:${PORT}/api/webhooks/github`);
    console.log(`🩺 Health check endpoint:   http://0.0.0.0:${PORT}/health\n`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[GitHub Discord Bot] Gracefully shutting down...');
    scheduler.stop();
    pipeline.stopQueueProcessor();
    server.close(() => {
      console.log('[GitHub Discord Bot] HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
