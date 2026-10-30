import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  initDatabase,
  addRepository,
  getRepositoryById,
  getRepositoryByFullName,
  getAllRepositories,
  updateRepository,
  deleteRepository,
  isEventProcessed,
  getRecentProcessedEvents,
  enqueueDelivery,
  getPendingDeliveries,
  getQueueStatus,
  retryDeliveryItem,
  retryAllDeadLetters
} from '../src/db/database.js';
import {
  GitHubService,
  PrivateRepositoryError,
  RepositoryNotFoundError
} from '../src/services/github.js';
import { EventNormalizer } from '../src/services/normalizer.js';
import { EventPipeline } from '../src/services/deduplicator.js';
import { DiscordService } from '../src/services/discord.js';
import { PollingScheduler } from '../src/services/scheduler.js';
import { createServer } from '../src/server.js';

// Setup fresh isolated in-memory DB for test suite
function setupTestDb() {
  const db = initDatabase(':memory:');
  return db;
}

function generateSignature(body, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  return `sha256=${hmac.update(body).digest('hex')}`;
}

test('GitHub Discord Bot Comprehensive Test Suite', async (t) => {

  // -----------------------------------------------------------
  // 1. Webhook Security & Signatures
  // -----------------------------------------------------------
  await t.test('1. Webhook Signature Verification and Tamper Protection', async () => {
    const secret = 'super-secret-key-123';
    const validBody = JSON.stringify({ action: 'opened', repository: { full_name: 'test/repo' } });
    const validSig = generateSignature(validBody, secret);

    // Valid signature accepted
    assert.equal(EventNormalizer.verifyWebhookSignature(validBody, validSig, secret), true);

    // Invalid signature rejected
    assert.equal(EventNormalizer.verifyWebhookSignature(validBody, 'sha256=invalidhash', secret), false);

    // Missing signature rejected
    assert.equal(EventNormalizer.verifyWebhookSignature(validBody, null, secret), false);

    // Tampered body rejected
    const tamperedBody = JSON.stringify({ action: 'opened', repository: { full_name: 'attacker/repo' } });
    assert.equal(EventNormalizer.verifyWebhookSignature(tamperedBody, validSig, secret), false);

    // Unsupported event returns null safely without crashing
    const unsupported = EventNormalizer.normalizeWebhook('gollum', { action: 'updated' });
    assert.equal(unsupported, null);
  });

  // -----------------------------------------------------------
  // 2. Repository Monitoring Scenarios
  // -----------------------------------------------------------
  await t.test('2. User-Owned Public Repository (Webhook Mode)', async () => {
    setupTestDb();

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: 101,
        owner: { login: 'alice' },
        name: 'my-app',
        full_name: 'alice/my-app',
        private: false,
        stargazers_count: 50
      })
    });

    const gh = new GitHubService({ fetchFn: mockFetch });
    const verified = await gh.verifyRepository('alice', 'my-app');

    const repo = addRepository({
      github_id: verified.id,
      owner: verified.owner,
      name: verified.name,
      full_name: verified.fullName,
      is_owned: true,
      monitoring_type: 'webhook'
    });

    assert.equal(repo.is_owned, true);
    assert.equal(repo.monitoring_type, 'webhook');
    assert.equal(repo.preferences.notify_releases, true);
    assert.equal(repo.preferences.notify_comments, true);
    assert.equal(repo.preferences.notify_reviews, true);
  });

  await t.test('3. External User & Organization Repositories (Polling Mode)', async () => {
    setupTestDb();

    const mockFetch = async (url) => {
      const name = url.includes('react') ? 'facebook/react' : 'bob/tool';
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          id: 202,
          owner: { login: name.split('/')[0] },
          name: name.split('/')[1],
          full_name: name,
          private: false
        })
      };
    };

    const gh = new GitHubService({ fetchFn: mockFetch });

    // External user repo
    const verifiedUser = await gh.verifyRepository('bob', 'tool');
    const repoUser = addRepository({
      owner: verifiedUser.owner,
      name: verifiedUser.name,
      full_name: verifiedUser.fullName,
      is_owned: false,
      monitoring_type: 'polling',
      polling_interval_seconds: 120
    });
    assert.equal(repoUser.is_owned, false);
    assert.equal(repoUser.monitoring_type, 'polling');
    assert.equal(repoUser.polling_interval_seconds, 120);

    // Organization repo
    const verifiedOrg = await gh.verifyRepository('facebook', 'react');
    const repoOrg = addRepository({
      owner: verifiedOrg.owner,
      name: verifiedOrg.name,
      full_name: verifiedOrg.fullName,
      is_owned: false,
      monitoring_type: 'polling'
    });
    assert.equal(repoOrg.full_name, 'facebook/react');
    assert.equal(repoOrg.monitoring_type, 'polling');
  });

  await t.test('4. Auto-Discovery of Newly Created Owned Repositories', async () => {
    setupTestDb();

    // Existing repo with custom settings
    const existing = addRepository({
      owner: 'alice',
      name: 'existing-tool',
      full_name: 'alice/existing-tool',
      is_owned: true,
      monitoring_type: 'webhook',
      preferences: { notify_releases: false }
    });

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => [
        { id: 1, owner: { login: 'alice' }, name: 'existing-tool', full_name: 'alice/existing-tool', private: false },
        { id: 2, owner: { login: 'alice' }, name: 'brand-new-repo', full_name: 'alice/brand-new-repo', private: false },
        { id: 3, owner: { login: 'alice' }, name: 'my-private-diary', full_name: 'alice/my-private-diary', private: true }
      ]
    });

    const gh = new GitHubService({ fetchFn: mockFetch, token: 'fake_token' });
    const scheduler = new PollingScheduler({ githubService: gh });

    const result = await scheduler.runDiscoveryCycle();
    assert.equal(result.discovered, 1);

    // Verify newly discovered repo was added as owned webhook
    const newRepo = getRepositoryByFullName('alice/brand-new-repo');
    assert.ok(newRepo);
    assert.equal(newRepo.is_owned, true);
    assert.equal(newRepo.monitoring_type, 'webhook');

    // Verify existing repo preferences were NOT touched
    const existingAfter = getRepositoryById(existing.id);
    assert.equal(existingAfter.preferences.notify_releases, false);

    // Verify private repo was strictly ignored
    const privateRepo = getRepositoryByFullName('alice/my-private-diary');
    assert.equal(privateRepo, null);
  });

  await t.test('5. Rejection of Private Repositories', async () => {
    setupTestDb();

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: 999,
        owner: { login: 'alice' },
        name: 'classified',
        full_name: 'alice/classified',
        private: true
      })
    });

    const gh = new GitHubService({ fetchFn: mockFetch });

    await assert.rejects(
      async () => await gh.verifyRepository('alice', 'classified'),
      PrivateRepositoryError
    );

    assert.throws(() => {
      addRepository({
        owner: 'alice',
        name: 'classified',
        full_name: 'alice/classified',
        is_private: true
      });
    }, /cannot monitor private repositories/);
  });

  // -----------------------------------------------------------
  // 3. Event Normalization and Formatting
  // -----------------------------------------------------------
  await t.test('6. Event Formatting for All Required GitHub Categories', async () => {
    const repo = 'acme/webapp';
    const sender = { login: 'developer', avatar_url: 'https://avatar.url', html_url: 'https://github.com/developer' };

    // 1. Pull Request - Opened & Merged
    const prOpened = EventNormalizer.normalizeWebhook('pull_request', {
      action: 'opened',
      pull_request: { number: 42, title: 'Add auth', head: { ref: 'feat/auth' }, base: { ref: 'main' }, id: 1042 },
      repository: { full_name: repo },
      sender
    });
    assert.equal(prOpened.category, 'pull_request');
    assert.equal(prOpened.action, 'opened');
    assert.match(prOpened.title, /PR #42/);

    const prMerged = EventNormalizer.normalizeWebhook('pull_request', {
      action: 'closed',
      pull_request: { number: 42, title: 'Add auth', merged: true, id: 1042 },
      repository: { full_name: repo },
      sender
    });
    assert.equal(prMerged.action, 'merged');

    // 2. Issue - Opened, Assigned, Labeled
    const issueOpened = EventNormalizer.normalizeWebhook('issues', {
      action: 'opened',
      issue: { number: 10, title: 'Crash bug', id: 5010 },
      repository: { full_name: repo },
      sender
    });
    assert.equal(issueOpened.category, 'issue');
    assert.match(issueOpened.title, /Issue #10/);

    const issueAssigned = EventNormalizer.normalizeWebhook('issues', {
      action: 'assigned',
      issue: { number: 10, title: 'Crash bug', id: 5010 },
      assignee: { login: 'johndoe' },
      repository: { full_name: repo },
      sender
    });
    assert.match(issueAssigned.description, /@johndoe/);

    // 3. Star & Unstar
    const starEvent = EventNormalizer.normalizeWebhook('watch', {
      action: 'started',
      repository: { full_name: repo },
      sender
    });
    assert.equal(starEvent.category, 'star');
    assert.equal(starEvent.action, 'starred');

    const unstarEvent = EventNormalizer.normalizeWebhook('star', {
      action: 'deleted',
      repository: { full_name: repo },
      sender
    });
    assert.equal(unstarEvent.action, 'unstarred');

    // 4. Fork
    const forkEvent = EventNormalizer.normalizeWebhook('fork', {
      forkee: { full_name: 'developer/webapp', id: 9988 },
      repository: { full_name: repo },
      sender
    });
    assert.equal(forkEvent.category, 'fork');

    // 5. Release & Prerelease
    const releaseEvent = EventNormalizer.normalizeWebhook('release', {
      action: 'published',
      release: { id: 7001, tag_name: 'v2.0.0', name: 'v2.0 Release', prerelease: false },
      repository: { full_name: repo },
      sender
    });
    assert.equal(releaseEvent.category, 'release');
    assert.match(releaseEvent.title, /Release v2\.0\.0/);

    const prereleaseEvent = EventNormalizer.normalizeWebhook('release', {
      action: 'published',
      release: { id: 7002, tag_name: 'v2.1.0-beta.1', name: 'Beta 1', prerelease: true },
      repository: { full_name: repo },
      sender
    });
    assert.match(prereleaseEvent.title, /Prerelease/);

    // 6. Comments & Reviews
    const commentEvent = EventNormalizer.normalizeWebhook('issue_comment', {
      action: 'created',
      issue: { number: 42, title: 'Add auth', pull_request: {} },
      comment: { id: 8888, body: 'Looks great!' },
      repository: { full_name: repo },
      sender
    });
    assert.equal(commentEvent.category, 'comment');
    assert.match(commentEvent.title, /PR #42/);

    const reviewApproved = EventNormalizer.normalizeWebhook('pull_request_review', {
      action: 'submitted',
      pull_request: { number: 42 },
      review: { id: 9991, state: 'APPROVED', body: 'LGTM' },
      repository: { full_name: repo },
      sender
    });
    assert.equal(reviewApproved.category, 'review');
    assert.match(reviewApproved.title, /Approved/);

    const reviewChanges = EventNormalizer.normalizeWebhook('pull_request_review', {
      action: 'submitted',
      pull_request: { number: 42 },
      review: { id: 9992, state: 'CHANGES_REQUESTED', body: 'Please fix tests' },
      repository: { full_name: repo },
      sender
    });
    assert.match(reviewChanges.title, /Changes Requested/);

    // Verify Discord safety: allowed_mentions
    const discord = new DiscordService({ mockMode: true });
    await discord.dispatchNotification(reviewApproved);
    const sent = discord.dispatchedLogs[0];
    assert.deepEqual(sent.payload.allowed_mentions, { parse: [] }, 'Must disable mentions to prevent spam');
  });

  // -----------------------------------------------------------
  // 4. Deduplication and Durable Delivery Outbox
  // -----------------------------------------------------------
  await t.test('7. Deduplication Between Webhook and Polling Sources', async () => {
    setupTestDb();

    addRepository({
      owner: 'acme',
      name: 'core',
      full_name: 'acme/core',
      is_owned: true,
      monitoring_type: 'webhook'
    });

    const discord = new DiscordService({ mockMode: true });
    const pipeline = new EventPipeline({ discordService: discord });

    const webhookEvent = {
      dedupKey: 'acme/core:release:1001',
      repository: 'acme/core',
      source: 'webhook',
      category: 'release',
      action: 'published',
      title: 'Release v1.0.0',
      description: 'First version'
    };

    // First arrival via webhook
    const outcome1 = await pipeline.processEvent(webhookEvent, true);
    assert.equal(outcome1.delivered, true);
    assert.equal(discord.dispatchedLogs.length, 1);

    // Second arrival via polling for the exact same release
    const pollingEvent = {
      dedupKey: 'acme/core:release:1001',
      repository: 'acme/core',
      source: 'polling',
      category: 'release',
      action: 'published',
      title: 'Release v1.0.0',
      description: 'First version'
    };

    const outcome2 = await pipeline.processEvent(pollingEvent, true);
    assert.equal(outcome2.deduplicated, true);
    assert.equal(outcome2.delivered, false);
    assert.equal(discord.dispatchedLogs.length, 1, 'Duplicate must be suppressed');
  });

  await t.test('8. Durable Queue Restart Survival and Dead-Letter Recovery', async () => {
    setupTestDb();

    addRepository({
      owner: 'acme',
      name: 'queue-test',
      full_name: 'acme/queue-test',
      is_owned: true,
      monitoring_type: 'webhook'
    });

    // 1. Enqueue item into outbox
    const event = {
      dedupKey: 'acme/queue-test:issue:1:opened',
      repository: 'acme/queue-test',
      category: 'issue',
      action: 'opened',
      title: 'Bug report #1',
      description: 'Something broke'
    };

    const queueId = enqueueDelivery(event, 3); // Max 3 attempts
    assert.ok(queueId > 0);

    // Verify it is in pending state
    let pending = getPendingDeliveries(10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].dedup_key, event.dedupKey);

    // 2. Simulate failure during delivery
    const pipeline = new EventPipeline({
      discordService: {
        dispatchNotification: async () => ({ success: false, error: '503 Service Unavailable', attempts: 1 })
      }
    });

    await pipeline.deliverQueueItem(queueId, event);

    // Check status after 1 failure
    let status = getQueueStatus();
    assert.equal(status.failed, 1);

    // Fail remaining attempts to reach dead_letter
    await pipeline.deliverQueueItem(queueId, event);
    await pipeline.deliverQueueItem(queueId, event);

    status = getQueueStatus();
    assert.equal(status.dead_letter, 1, 'Must reach dead_letter after exhausting retries');

    // 3. Admin recovery: retry all dead letter items
    const reEnqueued = retryAllDeadLetters();
    assert.equal(reEnqueued, 1);

    status = getQueueStatus();
    assert.equal(status.pending, 1);
    assert.equal(status.dead_letter, 0);
  });

  // -----------------------------------------------------------
  // 5. Health, Readiness, and Webhook Receiver Endpoint
  // -----------------------------------------------------------
  await t.test('9. HTTP Health, Readiness, and Webhook Ingestion Endpoint', async () => {
    setupTestDb();

    const { app } = createServer({ skipDbInit: true });

    // Test health endpoint
    const healthRes = await makeRequest(app, 'GET', '/health');
    assert.equal(healthRes.statusCode, 200);
    assert.equal(healthRes.body.status, 'ok');

    // Test readiness endpoint
    const readyRes = await makeRequest(app, 'GET', '/ready');
    assert.equal(readyRes.statusCode, 200);
    assert.equal(readyRes.body.ready, true);

    // Test webhook ping
    const pingRes = await makeRequest(app, 'POST', '/api/webhooks/github', {
      headers: { 'x-github-event': 'ping' },
      body: { zen: 'Keep it simple' }
    });
    assert.equal(pingRes.statusCode, 200);
    assert.match(pingRes.body.message, /Pong/);
  });

  // -----------------------------------------------------------
  // 6. Multiple Discord Webhooks and Web UI Settings API
  // -----------------------------------------------------------
  await t.test('10. Multiple Discord Webhooks Parallel Dispatch & Web UI Settings API', async () => {
    setupTestDb();

    const deliveredUrls = [];
    const mockFetch = async (url) => {
      deliveredUrls.push(url);
      return {
        ok: true,
        status: 204,
        json: async () => ({})
      };
    };

    const discord = new DiscordService({
      fetchFn: mockFetch,
      webhooks: [
        { id: 'wh_1', name: 'General', url: 'https://discord.com/api/webhooks/111/aaa', enabled: true },
        { id: 'wh_2', name: 'Releases', url: 'https://discord.com/api/webhooks/222/bbb', enabled: true },
        { id: 'wh_3', name: 'Disabled', url: 'https://discord.com/api/webhooks/333/ccc', enabled: false }
      ]
    });

    assert.equal(discord.getActiveWebhooks().length, 2);
    assert.equal(discord.getAllWebhooks().length, 3);

    const testEvent = {
      dedupKey: 'repo:push:123',
      repository: 'alice/repo',
      category: 'push',
      title: '💻 Pushed 1 commit to main',
      description: 'feat: add multiple webhooks',
      url: 'https://github.com/alice/repo'
    };

    const dispatchResult = await discord.dispatchNotification(testEvent);
    assert.equal(dispatchResult.success, true);
    assert.equal(deliveredUrls.length, 2);
    assert.ok(deliveredUrls.includes('https://discord.com/api/webhooks/111/aaa'));
    assert.ok(deliveredUrls.includes('https://discord.com/api/webhooks/222/bbb'));

    // Test Server Settings API endpoints
    const { app } = createServer({ skipDbInit: true, discordService: discord });

    // Save settings via POST /api/settings
    const saveRes = await makeRequest(app, 'POST', '/api/settings', {
      body: {
        discord_webhooks: [
          { id: 'wh_a', name: 'Alerts', url: 'https://discord.com/api/webhooks/999/xxx', enabled: true }
        ],
        github_owner: 'RajnishOne',
        github_token: 'ghp_testToken12345678',
        github_webhook_secret: 'secret123',
        admin_api_key: 'adminkey456',
        default_polling_interval: '180'
      }
    });

    assert.equal(saveRes.statusCode, 200);
    assert.equal(saveRes.body.success, true);

    // Retrieve settings via GET /api/settings
    const getRes = await makeRequest(app, 'GET', '/api/settings');
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.body.settings.github_owner, 'RajnishOne');
    assert.equal(getRes.body.settings.has_token, true);
    assert.equal(getRes.body.settings.default_polling_interval, '180');
    assert.equal(getRes.body.settings.discord_webhooks.length, 1);
    assert.equal(getRes.body.settings.discord_webhooks[0].name, 'Alerts');
  });

  // -----------------------------------------------------------
  // 11. Historical Event Suppression on Repository Addition
  // -----------------------------------------------------------
  await t.test('11. Historical Event Suppression on Repository Addition (Anti-Spam Baseline)', async () => {
    setupTestDb();

    // Repo added at t0
    const repoCreatedAt = new Date('2026-10-30T10:00:00Z').toISOString();
    const repo = addRepository({
      owner: 'acme',
      name: 'popular',
      full_name: 'acme/popular',
      is_owned: false,
      monitoring_type: 'polling',
      created_at: repoCreatedAt
    });

    const mockEventsHistory = [
      {
        id: 'ev-999',
        type: 'ReleaseEvent',
        created_at: '2026-10-30T09:59:00Z', // 1 min BEFORE addition (historical)
        payload: {
          action: 'published',
          release: { id: 101, tag_name: 'v1.0.0', name: 'Old Release' }
        }
      },
      {
        id: 'ev-998',
        type: 'IssuesEvent',
        created_at: '2026-10-30T08:00:00Z', // 2 hours BEFORE addition (historical)
        payload: {
          action: 'opened',
          issue: { number: 42, title: 'Old Issue' }
        }
      }
    ];

    let currentEvents = [...mockEventsHistory];

    const mockFetch = async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ etag: '"etag-123"' }),
        json: async () => currentEvents
      };
    };

    const discord = new DiscordService({ mockMode: true });
    const pipeline = new EventPipeline({ discordService: discord });
    const gh = new GitHubService({ fetchFn: mockFetch });
    const scheduler = new PollingScheduler({ githubService: gh, pipeline });

    // FIRST POLL: Should establish baseline and skip both historical events!
    const firstPollResult = await scheduler.pollRepository(repo);
    assert.equal(firstPollResult.success, true);
    assert.equal(firstPollResult.eventsCount, 2);
    assert.equal(firstPollResult.deliveredCount, 0, 'Historical events must NOT be delivered');
    assert.equal(discord.dispatchedLogs.length, 0, 'No Discord notifications should be sent for past events');

    const updatedRepo = getRepositoryById(repo.id);
    assert.equal(updatedRepo.last_event_id, 'ev-999', 'Latest event ID must be saved as checkpoint');
    assert.ok(updatedRepo.health_message.includes('Initial baseline established'));

    // SECOND POLL: A brand new release arrives AFTER repo addition
    const newEvent = {
      id: 'ev-1000',
      type: 'ReleaseEvent',
      created_at: '2026-10-30T10:05:00Z', // 5 mins AFTER addition (new)
      payload: {
        action: 'published',
        release: { id: 102, tag_name: 'v1.1.0', name: 'Brand New Release' }
      }
    };
    currentEvents = [newEvent, ...mockEventsHistory];

    const secondPollResult = await scheduler.pollRepository(updatedRepo);
    assert.equal(secondPollResult.success, true);
    assert.equal(secondPollResult.deliveredCount, 1, 'New event must be delivered');
    assert.equal(discord.dispatchedLogs.length, 1, 'Discord must receive the new event notification');
  });

  // -----------------------------------------------------------
  // 12. Edit Repository Configuration (Ownership, Polling Frequency, Categories)
  // -----------------------------------------------------------
  await t.test('12. Edit Repository Configuration (Ownership, Polling Frequency, Categories)', async () => {
    setupTestDb();

    const repo = addRepository({
      owner: 'acme',
      name: 'editable-tool',
      full_name: 'acme/editable-tool',
      is_owned: false,
      monitoring_type: 'polling',
      polling_interval_seconds: 300
    });

    const { app } = createServer({ skipDbInit: true });

    // Edit polling interval, ownership, and notification categories
    const editRes = await makeRequest(app, 'PUT', `/api/repositories/${repo.id}`, {
      body: {
        is_owned: true,
        monitoring_type: 'polling',
        polling_interval_seconds: 600,
        preferences: {
          notify_releases: true,
          notify_pull_requests: false,
          notify_issues: true,
          notify_pushes: true,
          notify_comments: true,
          notify_reviews: true
        }
      }
    });

    assert.equal(editRes.statusCode, 200);
    assert.equal(editRes.body.success, true);
    assert.equal(editRes.body.repository.is_owned, true);
    assert.equal(editRes.body.repository.monitoring_type, 'polling');
    assert.equal(editRes.body.repository.polling_interval_seconds, 600);
    assert.equal(editRes.body.repository.preferences.notify_pull_requests, false);
    assert.equal(editRes.body.repository.preferences.notify_pushes, true);
    assert.equal(editRes.body.repository.preferences.notify_comments, true);
    assert.equal(editRes.body.repository.preferences.notify_reviews, true);
  });

});

// Helper for testing express routes without network
async function makeRequest(app, method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const req = {
      method,
      url,
      headers: {
        'content-type': 'application/json',
        ...headers
      },
      body: body || {},
      query: {}
    };

    const res = {
      statusCode: 200,
      headers: {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(k, v) {
        this.headers[k] = v;
      },
      json(data) {
        this.body = data;
        resolve(this);
      },
      send(data) {
        this.body = data;
        resolve(this);
      }
    };

    app.handle(req, res);
  });
}
