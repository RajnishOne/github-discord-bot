import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActivityType,
  EmbedBuilder,
  PermissionFlagsBits
} from 'discord.js';
import {
  getAllRepositories,
  getRepositoryByFullName,
  addRepository,
  deleteRepository,
  getQueueStatus,
  getSetting,
  setSetting
} from '../db/database.js';
import { GitHubService } from './github.js';

export class DiscordBotService {
  constructor(options = {}) {
    this.token = options.token || process.env.DISCORD_BOT_TOKEN || '';
    this.clientId = options.clientId || process.env.DISCORD_CLIENT_ID || '';
    this.defaultChannelId = options.defaultChannelId || process.env.DISCORD_CHANNEL_ID || '';
    this.guildId = options.guildId || process.env.DISCORD_GUILD_ID || '';

    this.githubService = options.githubService || null;
    this.scheduler = options.scheduler || null;
    this.mockMode = options.mockMode || false;

    this.client = null;
    this.isConnecting = false;
    this.lastError = null;
  }

  isReady() {
    if (this.mockMode) return true;
    return Boolean(this.client && this.client.isReady());
  }

  setMockMode(enabled) {
    this.mockMode = enabled;
  }

  getStatus() {
    const ready = this.isReady();
    return {
      configured: Boolean(this.token) || this.mockMode,
      online: ready,
      lastError: this.lastError,
      defaultChannelId: this.defaultChannelId || null,
      clientId: this.clientId || (this.client?.user?.id ?? (this.mockMode ? '123456789012345678' : null)),
      guildId: this.guildId || null,
      ping: ready ? (this.client?.ws?.ping ?? 15) : -1,
      guildCount: ready ? (this.client?.guilds?.cache?.size ?? 1) : 0,
      user: ready && this.client?.user ? {
        id: this.client.user.id,
        tag: this.client.user.tag,
        username: this.client.user.username,
        avatarUrl: this.client.user.displayAvatarURL()
      } : (this.mockMode ? {
        id: '123456789012345678',
        tag: 'RepoBeacon#1234',
        username: 'RepoBeacon',
        avatarUrl: 'https://cdn.discordapp.com/avatars/123/abc.png'
      } : null)
    };
  }

  setToken(token) {
    this.token = token ? token.trim() : '';
  }

  setClientId(clientId) {
    this.clientId = clientId ? clientId.trim() : '';
  }

  setDefaultChannelId(channelId) {
    this.defaultChannelId = channelId ? channelId.trim() : '';
  }

  setGuildId(guildId) {
    this.guildId = guildId ? guildId.trim() : '';
  }

  setGitHubService(service) {
    this.githubService = service;
  }

  setScheduler(scheduler) {
    this.scheduler = scheduler;
  }

  async start() {
    if (this.mockMode) {
      this.isConnecting = false;
      return true;
    }

    if (!this.token) {
      console.log('[DiscordBot] No Bot Token configured. Standing by in secondary/webhook mode.');
      return false;
    }

    if (this.isReady()) {
      return true;
    }

    if (this.isConnecting) {
      return false;
    }

    this.isConnecting = true;
    this.lastError = null;

    try {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages
        ]
      });

      this.client.on('ready', async () => {
        this.isConnecting = false;
        console.log(`[DiscordBot] ✅ Connected to Discord Gateway as ${this.client.user.tag} (ID: ${this.client.user.id})`);

        if (!this.clientId) {
          this.clientId = this.client.user.id;
        }

        this.updatePresence();

        // Register / refresh slash commands
        try {
          await this.registerCommands();
        } catch (cmdErr) {
          console.warn('[DiscordBot] Slash command registration notice:', cmdErr.message);
        }
      });

      this.client.on('interactionCreate', async (interaction) => {
        try {
          await this.handleInteraction(interaction);
        } catch (err) {
          console.error('[DiscordBot] Interaction error:', err.message);
          if (interaction.isRepliable() && !interaction.replied) {
            const errorMsg = `❌ Error executing command: ${err.message}`;
            if (interaction.deferred) {
              await interaction.editReply({ content: errorMsg }).catch(() => {});
            } else {
              await interaction.reply({ content: errorMsg, ephemeral: true }).catch(() => {});
            }
          }
        }
      });

      this.client.on('error', (err) => {
        this.lastError = err.message;
        console.error('[DiscordBot] Gateway Client error:', err.message);
      });

      await this.client.login(this.token);
      return true;
    } catch (err) {
      this.isConnecting = false;
      this.lastError = err.message;
      console.error('[DiscordBot] Failed to log in to Discord Gateway:', err.message);
      return false;
    }
  }

  async stop() {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch {}
      this.client = null;
    }
    this.isConnecting = false;
  }

  async restart() {
    await this.stop();
    if (this.token) {
      return await this.start();
    }
    return false;
  }

  updatePresence() {
    if (!this.isReady() || !this.client?.user) return;
    try {
      const repos = getAllRepositories();
      const count = repos.length;
      this.client.user.setActivity({
        name: `${count} ${count === 1 ? 'repository' : 'repositories'}`,
        type: ActivityType.Watching
      });
    } catch (err) {
      console.warn('[DiscordBot] Failed to update presence:', err.message);
    }
  }

  async sendToChannel(channelId = null, payload = {}) {
    const targetChannelId = channelId || this.defaultChannelId;

    if (!targetChannelId) {
      throw new Error('No target Discord Channel ID specified and no default channel configured.');
    }

    if (!this.isReady()) {
      throw new Error('Discord Bot client is not connected to Gateway.');
    }

    if (this.mockMode && !this.client) {
      return {
        success: true,
        messageId: `mock_msg_${Date.now()}`,
        channelId: targetChannelId,
        channelName: 'mock-channel',
        payload
      };
    }

    const channel = await this.client.channels.fetch(targetChannelId).catch(err => {
      throw new Error(`Failed to fetch channel <#${targetChannelId}>: ${err.message}`);
    });

    if (!channel || !channel.isTextBased()) {
      throw new Error(`Channel <#${targetChannelId}> was not found or is not a text channel.`);
    }

    const message = await channel.send(payload);
    return {
      success: true,
      messageId: message.id,
      channelId: channel.id,
      channelName: channel.name
    };
  }

  async registerCommands() {
    const effectiveClientId = this.clientId || this.client?.user?.id;
    if (!effectiveClientId) {
      console.warn('[DiscordBot] Cannot register slash commands: Missing Client ID.');
      return;
    }

    const rest = new REST({ version: '10' }).setToken(this.token);

    const commands = [
      new SlashCommandBuilder()
        .setName('status')
        .setDescription('Show RepoBeacon monitoring health, GitHub rate limits, and outbox queue backlog.'),

      new SlashCommandBuilder()
        .setName('repos')
        .setDescription('List all GitHub repositories currently monitored by RepoBeacon.'),

      new SlashCommandBuilder()
        .setName('watch')
        .setDescription('Add a public GitHub repository to your watchlist.')
        .addStringOption(option =>
          option.setName('repository')
            .setDescription('GitHub repository identifier (e.g. facebook/react or expressjs/express)')
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option.setName('interval')
            .setDescription('Polling frequency in seconds (default: 300, min: 30)')
            .setRequired(false)
        ),

      new SlashCommandBuilder()
        .setName('unwatch')
        .setDescription('Remove a repository from the RepoBeacon watchlist.')
        .addStringOption(option =>
          option.setName('repository')
            .setDescription('Repository name (owner/repo) to remove')
            .setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Trigger an immediate poll check on a monitored repository.')
        .addStringOption(option =>
          option.setName('repository')
            .setDescription('Specific repository (owner/repo) or leave empty to poll all watched repos')
            .setRequired(false)
        ),

      new SlashCommandBuilder()
        .setName('setchannel')
        .setDescription('Set the default notification channel for RepoBeacon alerts.')
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Target text channel (leave blank to select current channel)')
            .setRequired(false)
        ),

      new SlashCommandBuilder()
        .setName('test')
        .setDescription('Send a test RepoBeacon notification to verify channel delivery.'),

      new SlashCommandBuilder()
        .setName('help')
        .setDescription('Display RepoBeacon commands and documentation.')
    ].map(cmd => cmd.toJSON());

    if (this.guildId) {
      console.log(`[DiscordBot] Registering ${commands.length} slash commands for Guild: ${this.guildId}...`);
      await rest.put(
        Routes.applicationGuildCommands(effectiveClientId, this.guildId),
        { body: commands }
      );
    } else {
      console.log(`[DiscordBot] Registering ${commands.length} global slash commands...`);
      await rest.put(
        Routes.applicationCommands(effectiveClientId),
        { body: commands }
      );
    }

    console.log('[DiscordBot] ✅ Slash commands successfully registered with Discord.');
  }

  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    switch (commandName) {
      case 'status':
        return await this.handleStatus(interaction);
      case 'repos':
        return await this.handleRepos(interaction);
      case 'watch':
        return await this.handleWatch(interaction);
      case 'unwatch':
        return await this.handleUnwatch(interaction);
      case 'poll':
        return await this.handlePoll(interaction);
      case 'setchannel':
        return await this.handleSetChannel(interaction);
      case 'test':
        return await this.handleTest(interaction);
      case 'help':
        return await this.handleHelp(interaction);
      default:
        await interaction.reply({ content: `Unknown command: /${commandName}`, ephemeral: true });
    }
  }

  async handleStatus(interaction) {
    await interaction.deferReply();

    const repos = getAllRepositories();
    const owned = repos.filter(r => r.is_owned);
    const watched = repos.filter(r => !r.is_owned);
    const active = repos.filter(r => r.enabled);
    const queue = getQueueStatus();

    let rateLimitText = 'Not checked';
    if (this.githubService) {
      try {
        const rl = await this.githubService.getRateLimitStatus();
        rateLimitText = `${rl.remaining} / ${rl.limit} (Resets in ${rl.resetMinutes}m)`;
      } catch (err) {
        rateLimitText = `Error: ${err.message}`;
      }
    }

    const defaultChannelDisplay = this.defaultChannelId ? `<#${this.defaultChannelId}>` : 'Not configured';

    const embed = new EmbedBuilder()
      .setTitle('🛰️ RepoBeacon System Status')
      .setColor(0x10B981)
      .setDescription('Real-time GitHub repository telemetry and Discord notification engine.')
      .addFields(
        { name: 'Monitored Repositories', value: `Total: **${repos.length}** (👑 ${owned.length} Owned, 👁️ ${watched.length} Watched, ⚡ ${active.length} Active)`, inline: false },
        { name: 'GitHub API Quota', value: `\`${rateLimitText}\``, inline: true },
        { name: 'Gateway Latency', value: `\`${this.client?.ws?.ping ?? 0}ms\``, inline: true },
        { name: 'Default Channel', value: defaultChannelDisplay, inline: true },
        { name: 'Outbox Delivery Queue', value: `Pending: **${queue.pending}** | Processing: **${queue.processing}** | Delivered: **${queue.delivered}** | Failed: **${queue.failed}** | Dead Letter: **${queue.dead_letter}**`, inline: false }
      )
      .setFooter({ text: 'RepoBeacon • Status' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  async handleRepos(interaction) {
    await interaction.deferReply();

    const repos = getAllRepositories();
    if (repos.length === 0) {
      return await interaction.editReply({
        content: 'No repositories are currently monitored. Use `/watch <owner/repo>` to add one!'
      });
    }

    const owned = repos.filter(r => r.is_owned);
    const watched = repos.filter(r => !r.is_owned);

    const embed = new EmbedBuilder()
      .setTitle(`📦 Monitored Repositories (${repos.length} Total)`)
      .setColor(0x3B82F6)
      .setFooter({ text: 'RepoBeacon • Repository List' })
      .setTimestamp();

    if (owned.length > 0) {
      const ownedList = owned.map(r => {
        const status = r.enabled ? '🟢' : '⏸️';
        return `${status} [${r.full_name}](https://github.com/${r.full_name}) *(Webhook)*`;
      }).slice(0, 15).join('\n');
      embed.addFields({ name: `👑 Owned Repositories (${owned.length})`, value: ownedList });
    }

    if (watched.length > 0) {
      const watchedList = watched.map(r => {
        const status = r.enabled ? '🟢' : '⏸️';
        const interval = `${Math.round(r.polling_interval_seconds / 60)}m`;
        return `${status} [${r.full_name}](https://github.com/${r.full_name}) *(${interval})*`;
      }).slice(0, 15).join('\n');
      embed.addFields({ name: `👁️ Watched Public Repositories (${watched.length})`, value: watchedList });
    }

    await interaction.editReply({ embeds: [embed] });
  }

  async handleWatch(interaction) {
    await interaction.deferReply();

    const input = interaction.options.getString('repository', true);
    const interval = interaction.options.getInteger('interval') || 300;

    if (!this.githubService) {
      return await interaction.editReply({
        content: '❌ GitHub API service is not initialized on this instance.'
      });
    }

    try {
      const { owner, name, fullName } = GitHubService.parseRepoInput(input);
      const verified = await this.githubService.verifyRepository(owner, name);

      // Check if already monitored
      const existing = getRepositoryByFullName(verified.fullName);
      if (existing) {
        return await interaction.editReply({
          content: `ℹ️ **${verified.fullName}** is already in your RepoBeacon watchlist!`
        });
      }

      // Add to database
      const newRepo = addRepository({
        github_id: verified.id,
        owner: verified.owner,
        name: verified.name,
        full_name: verified.fullName,
        is_owned: false,
        monitoring_type: 'polling',
        enabled: true,
        polling_interval_seconds: Math.max(30, interval),
        health_status: 'healthy',
        health_message: 'Added via Discord slash command',
        discord_channel_id: interaction.channelId
      });

      this.updatePresence();

      // Establish baseline poll in background
      if (this.scheduler) {
        this.scheduler.pollRepository(newRepo).catch(err => {
          console.warn(`[DiscordBot] Initial poll error for ${newRepo.full_name}:`, err.message);
        });
      }

      const embed = new EmbedBuilder()
        .setTitle('✅ Repository Added to Watchlist')
        .setColor(0x10B981)
        .setDescription(`RepoBeacon is now monitoring [${verified.fullName}](https://github.com/${verified.fullName})!`)
        .addFields(
          { name: 'Monitoring Mode', value: '🔄 Public API Polling', inline: true },
          { name: 'Polling Interval', value: `Every ${Math.round(newRepo.polling_interval_seconds / 60)}m`, inline: true },
          { name: 'Target Channel', value: `<#${interaction.channelId}>`, inline: true },
          { name: 'Repository Stats', value: `⭐ ${verified.stars} stars | 🍴 ${verified.forks} forks | 🐛 ${verified.openIssues} open issues`, inline: false }
        )
        .setFooter({ text: 'RepoBeacon • Repository Watcher' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply({
        content: `❌ Could not add repository: ${err.message}`
      });
    }
  }

  async handleUnwatch(interaction) {
    await interaction.deferReply();

    const input = interaction.options.getString('repository', true);
    const { fullName } = GitHubService.parseRepoInput(input);

    const repo = getRepositoryByFullName(fullName);
    if (!repo) {
      return await interaction.editReply({
        content: `⚠️ Repository **${fullName}** is not in your watchlist.`
      });
    }

    deleteRepository(repo.id);
    this.updatePresence();

    const embed = new EmbedBuilder()
      .setTitle('🗑️ Repository Removed')
      .setColor(0xEF4444)
      .setDescription(`[${fullName}](https://github.com/${fullName}) has been removed from the RepoBeacon watchlist.`)
      .setFooter({ text: 'RepoBeacon • Watcher' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  async handlePoll(interaction) {
    await interaction.deferReply();

    const targetRepo = interaction.options.getString('repository');

    if (!this.scheduler) {
      return await interaction.editReply({ content: '❌ Polling scheduler is not available.' });
    }

    if (targetRepo) {
      const { fullName } = GitHubService.parseRepoInput(targetRepo);
      const repo = getRepositoryByFullName(fullName);
      if (!repo) {
        return await interaction.editReply({
          content: `⚠️ Repository **${fullName}** is not in your watchlist.`
        });
      }

      const result = await this.scheduler.pollRepositoryNow(repo.id);
      return await interaction.editReply({
        content: `🔄 **Poll Complete for ${fullName}:** Captured ${result.eventsFound} events, ${result.deliveredCount} delivered to Discord.`
      });
    } else {
      const result = await this.scheduler.pollAll();
      return await interaction.editReply({
        content: `🔄 **Batch Poll Complete:** Polled ${result.polled} repositories. Captured ${result.delivered} new events.`
      });
    }
  }

  async handleSetChannel(interaction) {
    await interaction.deferReply();

    const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

    if (!targetChannel || !targetChannel.isTextBased()) {
      return await interaction.editReply({
        content: '❌ Please specify a valid text channel.'
      });
    }

    this.defaultChannelId = targetChannel.id;
    setSetting('discord_channel_id', targetChannel.id);

    const embed = new EmbedBuilder()
      .setTitle('🎯 Default Channel Updated')
      .setColor(0x10B981)
      .setDescription(`RepoBeacon notifications will now be dispatched to <#${targetChannel.id}> by default.`)
      .setFooter({ text: 'RepoBeacon • Configuration' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  async handleTest(interaction) {
    await interaction.deferReply();

    const testEmbed = new EmbedBuilder()
      .setTitle('🎯 RepoBeacon Discord Bot Test Connection')
      .setColor(0x10B981)
      .setDescription('RepoBeacon Discord Bot is successfully connected and transmitting to this channel!')
      .addFields(
        { name: 'Bot User', value: `\`${this.client?.user?.tag || 'RepoBeacon'}\``, inline: true },
        { name: 'Gateway Latency', value: `\`${this.client?.ws?.ping ?? 0}ms\``, inline: true },
        { name: 'Status', value: '✅ Fully Operational', inline: true }
      )
      .setFooter({ text: 'RepoBeacon Notification System' })
      .setTimestamp();

    await interaction.editReply({ embeds: [testEmbed] });
  }

  async handleHelp(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('📖 RepoBeacon Slash Command Guide')
      .setColor(0x8B5CF6)
      .setDescription('RepoBeacon captures GitHub releases, pull requests, issues, and commits, relaying them to your Discord channels.')
      .addFields(
        { name: '`/status`', value: 'Displays live monitoring health, GitHub API quota, and outbox delivery queue counts.', inline: false },
        { name: '`/repos`', value: 'Lists all owned and watched repositories currently tracked.', inline: false },
        { name: '`/watch <repo> [interval]`', value: 'Adds an external public repository to monitor (e.g. `/watch facebook/react 300`).', inline: false },
        { name: '`/unwatch <repo>`', value: 'Removes a repository from monitoring.', inline: false },
        { name: '`/poll [repo]`', value: 'Triggers an immediate polling cycle for one or all repositories.', inline: false },
        { name: '`/setchannel [channel]`', value: 'Sets the default Discord text channel for GitHub event broadcasts.', inline: false },
        { name: '`/test`', value: 'Dispatches a test verification embed to test permissions.', inline: false }
      )
      .setFooter({ text: 'RepoBeacon • Real-Time GitHub Telemetry' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }
}
