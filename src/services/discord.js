export class DiscordService {
  constructor(options = {}) {
    this.webhookUrl = options.webhookUrl || null;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.mockMode = options.mockMode || false;
    this.dispatchedLogs = [];
  }

  setWebhookUrl(url) {
    this.webhookUrl = url;
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

    if (this.mockMode || !this.webhookUrl) {
      return {
        success: true,
        mock: true,
        statusCode: 204,
        payload
      };
    }

    // Deliver to real Discord Webhook
    return await this.sendWithRetry(this.webhookUrl, payload);
  }

  async sendTestNotification(customUrl = null) {
    const targetUrl = customUrl || this.webhookUrl;
    if (!targetUrl) {
      throw new Error('Discord Webhook URL is not configured.');
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

    return await this.sendWithRetry(targetUrl, payload);
  }

  async sendWithRetry(url, payload, retries = 1) {
    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.status === 429 && retries > 0) {
        const body = await response.json().catch(() => ({}));
        const retryAfterSec = body.retry_after || 2;
        if (retryAfterSec <= 5) {
          await new Promise(resolve => setTimeout(resolve, retryAfterSec * 1000));
          return this.sendWithRetry(url, payload, retries - 1);
        }
      }

      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          statusCode: response.status,
          error: `Discord Webhook error (${response.status}): ${text}`
        };
      }

      return {
        success: true,
        statusCode: response.status
      };
    } catch (err) {
      return {
        success: false,
        statusCode: 500,
        error: err.message
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
