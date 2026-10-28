import {
  isEventProcessed,
  recordProcessedEvent,
  getRepositoryByFullName,
  enqueueDelivery,
  getPendingDeliveries,
  markDeliveryProcessing,
  markDeliverySuccess,
  markDeliveryFailure
} from '../db/database.js';

export class EventPipeline {
  constructor(options = {}) {
    this.discordService = options.discordService;
    this.queueTimer = null;
    this.isProcessingQueue = false;
    this.processIntervalMs = options.processIntervalMs || 2000; // Check queue every 2 seconds
  }

  setDiscordService(discordService) {
    this.discordService = discordService;
  }

  startQueueProcessor() {
    if (this.queueTimer) return;
    this.queueTimer = setInterval(() => this.processQueue(), this.processIntervalMs);
  }

  stopQueueProcessor() {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
  }

  /**
   * Durable acceptance: Enqueues an event into the SQLite outbox queue.
   *
   * @param {object} event - NormalizedEvent object
   * @param {boolean} immediate - If true, deliver immediately and wait (useful for polling or tests)
   */
  async processEvent(event, immediate = false) {
    if (!event || !event.dedupKey) {
      return { delivered: false, deduplicated: false, filteredOut: true, error: 'Invalid event format.' };
    }

    // 1. Deduplication check
    if (isEventProcessed(event.dedupKey)) {
      return {
        delivered: false,
        deduplicated: true,
        filteredOut: false,
        message: `Duplicate event suppressed: ${event.dedupKey}`
      };
    }

    // 2. Repository existence and preference check
    const repo = getRepositoryByFullName(event.repository);
    if (!repo) {
      return {
        delivered: false,
        deduplicated: false,
        filteredOut: true,
        message: `Repository ${event.repository} is not in watchlist.`
      };
    }

    if (!repo.enabled) {
      recordProcessedEvent({
        ...event,
        delivered_to_discord: 0,
        discord_response_status: null
      });
      return {
        delivered: false,
        deduplicated: false,
        filteredOut: true,
        message: `Monitoring disabled for repository ${event.repository}.`
      };
    }

    // Check category preferences
    const isCategoryEnabled = this.isCategoryEnabled(repo.preferences, event.category);
    if (!isCategoryEnabled) {
      recordProcessedEvent({
        ...event,
        delivered_to_discord: 0,
        discord_response_status: null
      });
      return {
        delivered: false,
        deduplicated: false,
        filteredOut: true,
        message: `Category "${event.category}" notifications disabled for ${event.repository}.`
      };
    }

    // 3. Durable persistence into SQLite outbox
    const queueId = enqueueDelivery(event);
    recordProcessedEvent({
      ...event,
      delivered_to_discord: 0,
      discord_response_status: null
    });

    if (immediate) {
      return await this.deliverQueueItem(queueId, event);
    }

    return {
      enqueued: true,
      queueId,
      delivered: false,
      deduplicated: false,
      filteredOut: false
    };
  }

  /**
   * Background queue worker processing pending outbox items
   */
  async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    try {
      const pendingItems = getPendingDeliveries(10);
      for (const item of pendingItems) {
        await this.deliverQueueItem(item.id, item.payload);
      }
    } catch (err) {
      console.error('[EventPipeline] Queue processing error:', err.message);
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Attempts delivery of an individual queue item with retry calculation
   */
  async deliverQueueItem(queueId, event) {
    markDeliveryProcessing(queueId);

    if (!this.discordService) {
      markDeliverySuccess(queueId);
      recordProcessedEvent({
        ...event,
        delivered_to_discord: 1,
        discord_response_status: 200
      });
      return { delivered: true, statusCode: 200 };
    }

    try {
      const result = await this.discordService.dispatchNotification(event);

      if (result.success) {
        markDeliverySuccess(queueId);
        recordProcessedEvent({
          ...event,
          delivered_to_discord: 1,
          discord_response_status: result.statusCode || 204
        });
        return { delivered: true, statusCode: result.statusCode || 204 };
      } else {
        // Calculate exponential backoff: 5s, 10s, 20s, 40s...
        const retryDelay = Math.min(300, Math.pow(2, (result.attempts || 1)) * 5);
        markDeliveryFailure(queueId, result.error || 'Discord delivery failed', retryDelay);
        return { delivered: false, error: result.error, retryDelay };
      }
    } catch (err) {
      markDeliveryFailure(queueId, err.message, 15);
      return { delivered: false, error: err.message };
    }
  }

  isCategoryEnabled(preferences, category) {
    if (!preferences) return true;
    switch (category) {
      case 'release':
        return preferences.notify_releases;
      case 'pull_request':
        return preferences.notify_pull_requests;
      case 'issue':
        return preferences.notify_issues;
      case 'push':
        return preferences.notify_pushes;
      case 'star':
        return preferences.notify_stars;
      case 'fork':
        return preferences.notify_forks;
      case 'comment':
        return preferences.notify_comments;
      case 'review':
        return preferences.notify_reviews;
      default:
        return true;
    }
  }
}
