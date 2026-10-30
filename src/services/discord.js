export class DiscordService {
  constructor(options = {}) {
    this.webhooks = [];
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.mockMode = options.mockMode || false;
    this.dispatchedLogs = [];

    if (options.webhooks) {
      this.setWebhooks(options.webhooks);
    } else if (options.webhookUrl) {
      this.setWebhookUrl(options.webhookUrl);
    }
  }

  setWebhookUrl(url) {
    if (!url) {
      this.webhooks = [];
      return;
    }
    // Supports comma or newline separated URLs, or a single URL
    const urls = typeof url === 'string'
      ? url.split(/[\n,]+/).map(u => u.trim()).filter(Boolean)
      : Array.isArray(url) ? url : [url];

    this.webhooks = urls.map((u, i) => {
      if (typeof u === 'object' && u !== null) {
        return {
          id: u.id || `wh_${Date.now()}_${i}`,
          name: u.name || `Webhook ${i + 1}`,
          url: u.url || '',
          enabled: u.enabled !== false
        };
      }
      return {
        id: `wh_${Date.now()}_${i}`,
        name: `Webhook ${i + 1}`,
        url: u,
        enabled: true
      };
    }).filter(w => Boolean(w.url));
  }

  setWebhooks(webhooks) {
    if (!Array.isArray(webhooks)) {
      this.setWebhookUrl(webhooks);
      return;
    }
    this.webhooks = webhooks.map((w, i) => {
      if (typeof w === 'string') {
        return {
          id: `wh_${Date.now()}_${i}`,
          name: `Webhook ${i + 1}`,
          url: w.trim(),
          enabled: true
        };
      }
      return {
        id: w.id || `wh_${Date.now()}_${i}`,
        name: w.name ? w.name.trim() : `Webhook ${i + 1}`,
        url: w.url ? w.url.trim() : '',
        enabled: w.enabled !== false
      };
    }).filter(w => Boolean(w.url));
  }

  get webhookUrl() {
    const active = this.getActiveWebhooks();
    return active.length > 0 ? active[0].url : null;
  }

  getActiveWebhooks() {
    return this.webhooks.filter(w => w.enabled && w.url);
  }

  getAllWebhooks() {
    return this.webhooks;
  }

  setMockMode(enabled) {
    this.mockMode = enabled;
  }

  getEmbedColor(category) {
    switch (category) {
      case 'release':
        return 0x10B981; // Emerald Green
      case 'pull_request':
        return 0x8B5CF6; // Purple
      case 'issue':
        return 0xF59E0B; // Amber
      case 'push':
        return 0x3B82F6; // Blue
      case 'star':
        return 0xEC4899; // Pink
      case 'fork':
        return 0x6366F1; // Indigo
      case 'comment':
        return 0x06B6D4; // Cyan
      case 'review':
        return 0x14B8A6; // Teal
      default:
        return 0x64748B; // Slate
    }
  }

  createEmbed(event) {
    const color = this.getEmbedColor(event.category);
    const sourceLabel = event.source === 'webhook' ? '⚡ Real-time Webhook' : '🔄 Polling Adapter';

    const fields = [
      {
        name: 'Repository',
        value: `[${escapeDiscordMarkdown(event.repository)}](https://github.com/${event.repository})`,
        inline: true
      },
      {
        name: 'Source',
        value: sourceLabel,
        inline: true
      },
      {
        name: 'Category',
        value: (event.category || 'EVENT').toUpperCase(),
        inline: true
      }
    ];

    if (event.meta?.branchInfo) {
      fields.push({
        name: 'Branches',
        value: `\`${escapeDiscordMarkdown(event.meta.branchInfo)}\``,
        inline: true
      });
    }

    if (event.meta?.tag) {
      fields.push({
        name: 'Release Tag',
        value: `\`${escapeDiscordMarkdown(event.meta.tag)}\``,
        inline: true
      });
    }

    const embed = {
      title: truncateString(event.title || 'GitHub Activity', 240),
      url: event.url || `https://github.com/${event.repository}`,
      description: truncateString(event.description || '', 2000),
      color,
      author: {
        name: truncateString(event.actor?.name || 'GitHub User', 100),
        url: event.actor?.url || 'https://github.com',
        icon_url: event.actor?.avatarUrl || 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png'
      },
      fields,
      footer: {
        text: `GitHub Discord Bot • ${event.source ? event.source.toUpperCase() : 'MONITOR'}`
      },
      timestamp: event.timestamp || new Date().toISOString()
    };

    return embed;
  }

  async dispatchNotification(event) {
    const embed = this.createEmbed(event);
    const payload = {
      username: 'GitHub Discord Bot',
      avatar_url: 'https://raw.githubusercontent.com/primer/octicons/main/icons/pulse-24.svg',
      embeds: [embed],
      allowed_mentions: {
        parse: [] // Disable @everyone, @here, and user/role mentions
      }
    };

    this.dispatchedLogs.push({
      timestamp: new Date().toISOString(),
      event,
      payload
    });

    const activeWebhooks = this.getActiveWebhooks();

    if (this.mockMode || activeWebhooks.length === 0) {
      return {
        success: true,
        mock: true,
        statusCode: 204,
        payload
      };
    }

    // Deliver to all active Discord Webhooks in parallel
    const deliveryPromises = activeWebhooks.map(async (wh) => {
      try {
        const res = await this.sendWithRetry(wh.url, payload);
        return { id: wh.id, name: wh.name, url: wh.url, ...res };
      } catch (err) {
        return { id: wh.id, name: wh.name, url: wh.url, success: false, error: err.message };
      }
    });

    const results = await Promise.allSettled(deliveryPromises);
    const resolved = results.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message });

    const anySuccess = resolved.some(r => r.success);
    const allFailed = resolved.every(r => !r.success);

    if (allFailed && resolved.length > 0) {
      const firstError = resolved[0].error || 'All Discord deliveries failed.';
      const err = new Error(firstError);
      err.deliveries = resolved;
      throw err;
    }

    return {
      success: anySuccess,
      deliveries: resolved,
      statusCode: 204,
      payload
    };
  }

  async sendTestNotification(customUrl = null) {
    const targetUrls = customUrl
      ? [customUrl]
      : this.getActiveWebhooks().map(w => w.url);

    if (targetUrls.length === 0) {
      throw new Error('No active Discord Webhook URL is configured.');
    }

    const testEmbed = {
      title: '🎯 GitHub Discord Bot Webhook Test Connection',
      description: 'GitHub Discord Bot is successfully connected to your Discord server! You will receive notifications here according to your watched repository settings.',
      color: 0x10B981,
      fields: [
        { name: 'Status', value: '✅ Operational', inline: true },
        { name: 'Timestamp', value: new Date().toLocaleTimeString(), inline: true }
      ],
      footer: { text: 'GitHub Discord Bot Notification System' },
      timestamp: new Date().toISOString()
    };

    const payload = {
      username: 'GitHub Discord Bot',
      embeds: [testEmbed],
      allowed_mentions: { parse: [] }
    };

    if (customUrl) {
      return await this.sendWithRetry(customUrl, payload);
    }

    // Deliver to all targets in parallel
    const results = await Promise.all(targetUrls.map(u => this.sendWithRetry(u, payload)));
    return results[0];
  }

  async sendWithRetry(url, payload, retries = 1) {
    if (!url || typeof url !== 'string') {
      return { success: false, statusCode: 400, error: 'Discord Webhook URL is required.' };
    }

    const trimmedUrl = url.trim();
    const discordWebhookRegex = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[a-zA-Z0-9_-]+/;
    if (!discordWebhookRegex.test(trimmedUrl)) {
      return {
        success: false,
        statusCode: 400,
        error: 'Incomplete Discord Webhook URL. It must include both the Webhook ID and Secret Token (e.g. https://discord.com/api/webhooks/1234567890/abcdefgh...). Make sure to click "Copy Webhook URL" inside Discord Channel Settings.'
      };
    }

    try {
      const response = await this.fetchFn(trimmedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.status === 429 && retries > 0) {
        const body = await response.json().catch(() => ({}));
        const retryAfterSec = body.retry_after || 2;
        if (retryAfterSec <= 5) {
          await new Promise(resolve => setTimeout(resolve, retryAfterSec * 1000));
          return this.sendWithRetry(trimmedUrl, payload, retries - 1);
        }
      }

      if (!response.ok) {
        const text = await response.text();
        let userMessage = `Discord Webhook error (${response.status}): ${text}`;
        if (response.status === 404) {
          userMessage = `Discord returned 404 (Unknown Webhook). The webhook ID does not exist or was deleted.`;
        } else if (response.status === 401) {
          userMessage = `Discord returned 401 (Unauthorized). The webhook secret token is invalid.`;
        } else if (response.status === 405) {
          userMessage = `Discord returned 405 (Method Not Allowed). The URL is missing the webhook secret token.`;
        }
        return {
          success: false,
          statusCode: response.status,
          error: userMessage
        };
      }

      return {
        success: true,
        statusCode: response.status
      };
    } catch (err) {
      let errorMsg = err.message;
      if (err.message && err.message.includes('ENOTFOUND')) {
        errorMsg = 'DNS resolution failed: Container cannot resolve discord.com. Check Docker network / DNS settings.';
      }
      return {
        success: false,
        statusCode: 500,
        error: errorMsg
      };
    }
  }
}

function truncateString(str, maxLen = 2000) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

function escapeDiscordMarkdown(str) {
  if (!str) return '';
  return str.replace(/([*_`~|\\])/g, '\\$1');
}
