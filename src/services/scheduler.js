import {
  getAllRepositories,
  getRepositoryById,
  updateRepository,
  addRepository,
  getSetting
} from '../db/database.js';
import { EventNormalizer } from './normalizer.js';

export class PollingScheduler {
  constructor(options = {}) {
    this.githubService = options.githubService;
    this.pipeline = options.pipeline;
    this.checkIntervalMs = options.checkIntervalMs || 15000; // Check due repos every 15s
    this.discoveryIntervalMs = options.discoveryIntervalMs || 10 * 60 * 1000; // Discover every 10 min
    this.timer = null;
    this.discoveryTimer = null;
    this.isPolling = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runPollingCycle(), this.checkIntervalMs);
    this.discoveryTimer = setInterval(() => this.runDiscoveryCycle(), this.discoveryIntervalMs);
    console.log('[Scheduler] Background polling engine and auto-discovery started.');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    console.log('[Scheduler] Background polling engine stopped.');
  }

  /**
   * Main polling cycle: discovers which watched repos are due for polling
   */
  async runPollingCycle() {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const watchedRepos = getAllRepositories({ monitoring_type: 'polling' });
      const activeRepos = watchedRepos.filter(r => r.enabled);

      const now = Date.now();

      for (const repo of activeRepos) {
        const intervalMs = (repo.polling_interval_seconds || 300) * 1000;
        const lastPolled = repo.last_polled_at ? new Date(repo.last_polled_at).getTime() : 0;

        if (now - lastPolled >= intervalMs) {
          await this.pollRepository(repo);
        }
      }
    } catch (err) {
      console.error('[Scheduler] Error during polling cycle:', err.message);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Polls an individual repository using ETag and conditional request
   */
  async pollRepository(repo) {
    if (!this.githubService) return;

    try {
      const result = await this.githubService.pollRepositoryEvents(repo);

      const nowIso = new Date().toISOString();

      if (result.notModified) {
        // Cache is fresh, 304 received
        updateRepository(repo.id, {
          last_polled_at: nowIso,
          health_status: 'healthy',
          health_message: 'Up to date (304 Not Modified)'
        });
        return { success: true, notModified: true, eventsCount: 0 };
      }

      if (result.notFound) {
        updateRepository(repo.id, {
          last_polled_at: nowIso,
          health_status: 'not_found',
          health_message: result.error || 'Repository not found or moved.'
        });
        return { success: false, error: result.error };
      }

      if (result.rateLimited) {
        updateRepository(repo.id, {
          last_polled_at: nowIso,
          health_status: 'rate_limited',
          health_message: `GitHub rate limit exceeded. Retry in ${result.retryAfter || 60}s.`
        });
        return { success: false, rateLimited: true };
      }

      if (result.failed) {
        updateRepository(repo.id, {
          last_polled_at: nowIso,
          health_status: 'degraded',
          health_message: result.error
        });
        return { success: false, error: result.error };
      }

      // Normal events received
      const events = result.events || [];
      let deliveredCount = 0;

      // Process events in chronological order (oldest to newest)
      const chronologicalEvents = [...events].reverse();

      for (const ev of chronologicalEvents) {
        const normalized = EventNormalizer.normalizePollingEvent(ev, repo.full_name);
        if (normalized && this.pipeline) {
          const outcome = await this.pipeline.processEvent(normalized);
          if (outcome.delivered) deliveredCount++;
        }
      }

      updateRepository(repo.id, {
        last_polled_at: nowIso,
        last_etag: result.etag,
        last_event_id: result.latestEventId,
        health_status: 'healthy',
        health_message: `Polled successfully: ${events.length} new event(s), ${deliveredCount} notified.`
      });

      return {
        success: true,
        eventsCount: events.length,
        deliveredCount,
        latestEventId: result.latestEventId
      };
    } catch (err) {
      console.error(`[Scheduler] Failed to poll repository ${repo.full_name}:`, err.message);
      updateRepository(repo.id, {
        health_status: 'degraded',
        health_message: err.message
      });
      return { success: false, error: err.message };
    }
  }

  /**
   * Trigger immediate poll of a single repository
   */
  async pollRepositoryNow(repoId) {
    const repo = getRepositoryById(repoId);
    if (!repo) {
      throw new Error(`Repository with ID ${repoId} not found.`);
    }
    return await this.pollRepository(repo);
  }

  /**
   * Auto-discovery cycle for newly created public repositories owned by user
   */
  async runDiscoveryCycle() {
    if (!this.githubService) return { discovered: 0 };

    try {
      const discoveryResult = await this.githubService.discoverOwnedRepositories();
      const discoveredRepos = discoveryResult.repos || [];

      if (discoveredRepos.length === 0) return { discovered: 0 };

      const existingRepos = getAllRepositories();
      const existingFullNames = new Set(existingRepos.map(r => r.full_name.toLowerCase()));

      let addedCount = 0;
      for (const repo of discoveredRepos) {
        if (!existingFullNames.has(repo.fullName.toLowerCase())) {
          // Strictly ensure it's not private
          if (repo.isPrivate) continue;

          console.log(`[Scheduler] Auto-discovered new owned public repository: ${repo.fullName}`);
          addRepository({
            github_id: repo.id,
            owner: repo.owner,
            name: repo.name,
            full_name: repo.fullName,
            is_owned: true,
            monitoring_type: 'webhook', // Owned repositories default to webhook
            enabled: true,
            polling_interval_seconds: 300,
            health_status: 'healthy',
            health_message: 'Auto-discovered owned repository'
          });
          addedCount++;
        }
      }

      return { discovered: addedCount, totalFound: discoveredRepos.length };
    } catch (err) {
      console.error('[Scheduler] Error during auto-discovery:', err.message);
      return { discovered: 0, error: err.message };
    }
  }
}
