#!/usr/bin/env node

import {
  initDatabase,
  getQueueStatus,
  getPendingDeliveries,
  retryDeliveryItem,
  retryAllDeadLetters,
  getAllRepositories,
  deleteRepository,
  getSetting
} from '../src/db/database.js';
import { DiscordBotService } from '../src/services/discord-bot.js';

const command = process.argv[2];
const arg1 = process.argv[3];

initDatabase();

async function run() {
  switch (command) {
    case 'bot:status': {
      const token = getSetting('discord_bot_token') || process.env.DISCORD_BOT_TOKEN;
      const clientId = getSetting('discord_client_id') || process.env.DISCORD_CLIENT_ID;
      const channelId = getSetting('discord_channel_id') || process.env.DISCORD_CHANNEL_ID;
      const guildId = getSetting('discord_guild_id') || process.env.DISCORD_GUILD_ID;

      console.log('\n🤖 RepoBeacon Discord Bot Status:');
      console.log('---------------------------------');
      console.log(`Bot Token:         ${token ? '✅ Configured (••••••••' + token.slice(-4) + ')' : '❌ Not set'}`);
      console.log(`Client ID:         ${clientId ? '✅ ' + clientId : '⚠️ Not set (auto-derived on login)'}`);
      console.log(`Default Channel:   ${channelId ? '✅ ' + channelId : '⚠️ Not set'}`);
      console.log(`Guild ID (Dev):    ${guildId ? '✅ ' + guildId : 'None (Global)'}\n`);
      break;
    }

    case 'bot:commands': {
      const token = getSetting('discord_bot_token') || process.env.DISCORD_BOT_TOKEN;
      const clientId = getSetting('discord_client_id') || process.env.DISCORD_CLIENT_ID;
      const guildId = getSetting('discord_guild_id') || process.env.DISCORD_GUILD_ID;

      if (!token) {
        console.error('Error: DISCORD_BOT_TOKEN is not configured.');
        process.exit(1);
      }

      console.log('\nDeploying slash commands to Discord...');
      const bot = new DiscordBotService({ token, clientId, guildId });
      await bot.registerCommands();
      console.log('✅ Slash commands successfully registered.\n');
      break;
    }

    case 'queue:status': {
      const status = getQueueStatus();
      console.log('\n📊 RepoBeacon Outbox Queue Status:');
      console.log('-----------------------------------');
      console.log(`Pending:      ${status.pending}`);
      console.log(`Processing:   ${status.processing}`);
      console.log(`Delivered:    ${status.delivered}`);
      console.log(`Failed:       ${status.failed}`);
      console.log(`Dead Letter:  ${status.dead_letter}\n`);
      break;
    }

    case 'queue:pending': {
      const items = getPendingDeliveries(20);
      console.log(`\n⏳ Found ${items.length} pending/failed item(s):`);
      items.forEach(i => {
        console.log(`[#${i.id}] ${i.repository_full_name} | ${i.event_category}:${i.event_action} | attempts: ${i.attempts}/${i.max_attempts} | error: ${i.last_error || 'none'}`);
      });
      console.log('');
      break;
    }

    case 'queue:retry': {
      if (!arg1) {
        console.error('Error: Please specify the delivery item ID: repobeacon queue:retry <id>');
        process.exit(1);
      }
      const success = retryDeliveryItem(arg1);
      if (success) {
        console.log(`✅ Item #${arg1} re-enqueued for delivery.`);
      } else {
        console.log(`❌ Item #${arg1} not found.`);
      }
      break;
    }

    case 'queue:retry-all': {
      const count = retryAllDeadLetters();
      console.log(`✅ Re-enqueued ${count} dead-letter item(s) for delivery.`);
      break;
    }

    case 'repos:list': {
      const repos = getAllRepositories();
      console.log(`\n📦 Monitored Repositories (${repos.length} total):`);
      console.log('--------------------------------------------------');
      repos.forEach(r => {
        const type = r.is_owned ? '👑 OWNED' : '👁️ WATCHED';
        const mode = r.monitoring_type.toUpperCase();
        const status = r.enabled ? 'ACTIVE' : 'PAUSED';
        console.log(`[#${r.id}] ${r.full_name.padEnd(30)} | ${type} | ${mode} | ${status} | ${r.health_status}`);
      });
      console.log('');
      break;
    }

    case 'repos:remove': {
      if (!arg1) {
        console.error('Error: Please specify the repository ID: repobeacon repos:remove <id>');
        process.exit(1);
      }
      const success = deleteRepository(arg1);
      if (success) {
        console.log(`✅ Repository #${arg1} removed.`);
      } else {
        console.log(`❌ Repository #${arg1} not found.`);
      }
      break;
    }

    default: {
      console.log(`
RepoBeacon Administrative CLI
-----------------------------
Usage: node bin/repobeacon-cli.js <command> [args]
       npm run cli -- <command> [args]
       repobeacon <command> [args]

Commands:
  bot:status            View Discord Bot configuration status
  bot:commands          Deploy slash commands to Discord application
  queue:status          View counts of pending, delivered, failed, and dead-letter items
  queue:pending         List up to 20 pending or retrying deliveries
  queue:retry <id>      Re-enqueue a specific failed or dead-letter item
  queue:retry-all       Re-enqueue all dead-letter items
  repos:list            List all monitored repositories and their health
  repos:remove <id>     Remove a repository from the database
      `);
      break;
    }
  }
}

run().catch(err => {
  console.error('CLI Error:', err.message);
  process.exit(1);
});

