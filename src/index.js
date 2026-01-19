require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const VATSIM_DATA_URL = 'https://data.vatsim.net/v3/vatsim-data.json';
const VATSIM_CID = process.env.VATSIM_CID;
const SCHEDULE_CHANNEL_ID = process.env.SCHEDULE_CHANNEL_ID;
const RULES_CHANNEL_ID = process.env.RULES_CHANNEL_ID;
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY;
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 4509;

// Load role config
let roleConfig = {};
try {
  const configPath = path.join(__dirname, '..', 'config.yaml');
  roleConfig = yaml.load(fs.readFileSync(configPath, 'utf8'));
  console.log('Loaded role config from config.yaml');
} catch (e) {
  console.warn('Warning: Could not load config.yaml. Auto-roles will not work.');
}

// ATC Rating names
const ATC_RATINGS = {
  1: 'OBS', 2: 'S1', 3: 'S2', 4: 'S3', 5: 'C1', 6: 'C2', 7: 'C3',
  8: 'I1', 9: 'I2', 10: 'I3', 11: 'SUP', 12: 'ADM'
};

// Pilot Rating names
const PILOT_RATINGS = {
  0: 'NEW', 1: 'PPL', 3: 'IR', 7: 'CMEL', 15: 'ATPL'
};

// Store message IDs for cleanup
let scheduleMessageIds = [];
let rulesMessageIds = [];

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  startWebhookServer();
  startAutoSync();
});

// VATSIM API Functions
async function getVatsimCidFromDiscord(discordUserId) {
  try {
    const response = await fetch(`https://api.vatsim.net/v2/members/discord/${discordUserId}`);
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`VATSIM API returned ${response.status}`);
    }
    const data = await response.json();
    return data.user_id || null;
  } catch (error) {
    console.error('Error fetching VATSIM CID from Discord:', error);
    throw error;
  }
}

async function getVatsimMemberData(cid) {
  try {
    const response = await fetch(`https://api.vatsim.net/v2/members/${cid}`);
    if (!response.ok) {
      throw new Error(`VATSIM API returned ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching VATSIM member data:', error);
    throw error;
  }
}

async function getVatsimPilotStats(cid) {
  try {
    const response = await fetch(`https://api.vatsim.net/v2/members/${cid}/stats`);
    if (!response.ok) {
      throw new Error(`VATSIM API returned ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching VATSIM pilot stats:', error);
    throw error;
  }
}

async function assignVatsimRoles(member, cid, memberData, pilotStats) {
  const rolesAdded = [];
  const rolesRemoved = [];
  const settings = roleConfig.settings || {};

  // Assign verified role
  if (roleConfig.verified_role) {
    try {
      await member.roles.add(roleConfig.verified_role);
      rolesAdded.push('Verified');
    } catch (e) {
      console.error('Error adding verified role:', e);
    }
  }

  // Assign ATC rating role
  const atcRating = memberData.rating;
  if (roleConfig.atc_roles && atcRating) {
    // Remove old ATC roles if configured
    if (settings.remove_old_atc_roles) {
      for (const [rating, roleId] of Object.entries(roleConfig.atc_roles)) {
        if (roleId && parseInt(rating) !== atcRating && member.roles.cache.has(roleId)) {
          try {
            await member.roles.remove(roleId);
            rolesRemoved.push(ATC_RATINGS[parseInt(rating)] || `ATC ${rating}`);
          } catch (e) {
            console.error(`Error removing ATC role ${rating}:`, e);
          }
        }
      }
    }

    const atcRoleId = roleConfig.atc_roles[atcRating];
    if (atcRoleId) {
      try {
        await member.roles.add(atcRoleId);
        rolesAdded.push(ATC_RATINGS[atcRating] || `ATC ${atcRating}`);
      } catch (e) {
        console.error('Error adding ATC role:', e);
      }
    }
  }

  // Assign default ATC role if rating > 1 (not just OBS)
  if (roleConfig.default_atc_role && atcRating > 1) {
    try {
      if (!member.roles.cache.has(roleConfig.default_atc_role)) {
        await member.roles.add(roleConfig.default_atc_role);
        rolesAdded.push('ATC');
      }
    } catch (e) {
      console.error('Error adding default ATC role:', e);
    }
  } else if (roleConfig.default_atc_role && atcRating <= 1) {
    // Remove default ATC role if they're OBS or below
    if (member.roles.cache.has(roleConfig.default_atc_role)) {
      try {
        await member.roles.remove(roleConfig.default_atc_role);
        rolesRemoved.push('ATC');
      } catch (e) {
        console.error('Error removing default ATC role:', e);
      }
    }
  }

  // Assign pilot rating role
  const pilotRating = memberData.pilotrating;
  if (roleConfig.pilot_rating_roles && pilotRating !== undefined) {
    // Remove old pilot rating roles if configured
    if (settings.remove_old_pilot_rating_roles) {
      for (const [rating, roleId] of Object.entries(roleConfig.pilot_rating_roles)) {
        if (roleId && parseInt(rating) !== pilotRating && member.roles.cache.has(roleId)) {
          try {
            await member.roles.remove(roleId);
            rolesRemoved.push(PILOT_RATINGS[parseInt(rating)] || `Pilot ${rating}`);
          } catch (e) {
            console.error(`Error removing pilot rating role ${rating}:`, e);
          }
        }
      }
    }

    const pilotRatingRoleId = roleConfig.pilot_rating_roles[pilotRating];
    if (pilotRatingRoleId) {
      try {
        await member.roles.add(pilotRatingRoleId);
        rolesAdded.push(PILOT_RATINGS[pilotRating] || `Pilot ${pilotRating}`);
      } catch (e) {
        console.error('Error adding pilot rating role:', e);
      }
    }
  }

  // Assign pilot hour roles
  if (roleConfig.pilot_hour_roles && pilotStats) {
    const totalHours = (pilotStats.pilot || 0) / 60; // Convert minutes to hours
    const hourThresholds = Object.keys(roleConfig.pilot_hour_roles)
      .map(Number)
      .sort((a, b) => b - a); // Sort descending

    // Find the highest threshold the user qualifies for
    let qualifiedThreshold = null;
    for (const threshold of hourThresholds) {
      if (totalHours >= threshold) {
        qualifiedThreshold = threshold;
        break;
      }
    }

    // Remove lower hour roles if configured
    if (settings.remove_lower_hour_roles) {
      for (const [hours, roleId] of Object.entries(roleConfig.pilot_hour_roles)) {
        const hoursNum = parseInt(hours);
        if (roleId && hoursNum !== qualifiedThreshold && member.roles.cache.has(roleId)) {
          try {
            await member.roles.remove(roleId);
            rolesRemoved.push(`${hoursNum}+ hrs`);
          } catch (e) {
            console.error(`Error removing hour role ${hours}:`, e);
          }
        }
      }
    }

    // Add qualified role
    if (qualifiedThreshold !== null) {
      const hourRoleId = roleConfig.pilot_hour_roles[qualifiedThreshold];
      if (hourRoleId) {
        try {
          await member.roles.add(hourRoleId);
          rolesAdded.push(`${qualifiedThreshold}+ hrs`);
        } catch (e) {
          console.error('Error adding hour role:', e);
        }
      }
    }
  }

  return { rolesAdded, rolesRemoved, totalHours: pilotStats ? (pilotStats.pilot || 0) / 60 : 0 };
}

// Auto-sync roles for all members (attempts to verify unverified members too)
async function autoSyncAllMembers() {
  const settings = roleConfig.settings || {};
  if (!roleConfig.verified_role) {
    console.log('Auto-sync skipped: No verified role configured');
    return;
  }

  console.log('Starting auto-sync of all members...');
  let synced = 0;
  let newlyVerified = 0;
  let errors = 0;

  for (const guild of client.guilds.cache.values()) {
    try {
      // Fetch all members (excluding bots)
      await guild.members.fetch();
      const allMembers = guild.members.cache.filter(m => !m.user.bot);

      for (const member of allMembers.values()) {
        try {
          const cid = await getVatsimCidFromDiscord(member.user.id);
          if (!cid) continue; // Not linked to VATSIM, skip

          const wasVerified = member.roles.cache.has(roleConfig.verified_role);

          const [memberData, pilotStats] = await Promise.all([
            getVatsimMemberData(cid),
            getVatsimPilotStats(cid)
          ]);

          await assignVatsimRoles(member, cid, memberData, pilotStats);

          if (!wasVerified) {
            newlyVerified++;
            console.log(`Auto-verified: ${member.user.tag} (CID: ${cid})`);
          }
          synced++;

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (e) {
          errors++;
          console.error(`Error syncing member ${member.user.tag}:`, e.message);
        }
      }
    } catch (e) {
      console.error(`Error fetching guild members:`, e.message);
    }
  }

  console.log(`Auto-sync complete: ${synced} members synced, ${newlyVerified} newly verified, ${errors} errors`);
}

function startAutoSync() {
  const settings = roleConfig.settings || {};
  const interval = settings.auto_sync_interval || 0;

  if (interval <= 0) {
    console.log('Auto-sync disabled (interval is 0)');
    return;
  }

  const intervalMs = interval * 60 * 1000;
  console.log(`Auto-sync enabled: running every ${interval} minutes`);

  // Run immediately on startup, then at interval
  setTimeout(() => {
    autoSyncAllMembers();
    setInterval(autoSyncAllMembers, intervalMs);
  }, 10000); // Wait 10 seconds after startup before first sync
}

// Webhook server for schedule updates
function startWebhookServer() {
  const app = express();
  app.use(express.json());

  app.post('/schedule', async (req, res) => {
    // Verify API key
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== WEBHOOK_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { streams } = req.body;

    if (!streams || !Array.isArray(streams)) {
      return res.status(400).json({ error: 'Invalid payload. Expected { streams: [...] }' });
    }

    try {
      const channel = await client.channels.fetch(SCHEDULE_CHANNEL_ID);
      if (!channel) {
        return res.status(404).json({ error: 'Schedule channel not found' });
      }

      // Clear old schedule messages
      if (scheduleMessageIds.length > 0) {
        try {
          await channel.bulkDelete(scheduleMessageIds);
        } catch (err) {
          // Messages might be too old for bulk delete, try individual delete
          for (const msgId of scheduleMessageIds) {
            try {
              const msg = await channel.messages.fetch(msgId);
              await msg.delete();
            } catch (e) {
              // Message might already be deleted
            }
          }
        }
        scheduleMessageIds = [];
      }

      // Create schedule embed
      const embed = new EmbedBuilder()
        .setColor(0x9146ff)
        .setTitle('Stream Schedule')
        .setTimestamp();

      if (streams.length === 0) {
        embed.setDescription('No streams scheduled at this time.');
      } else {
        const scheduleLines = streams.map(stream => {
          const title = stream.title || 'Untitled Stream';
          const description = stream.description || '';

          let line = '';
          if (stream.startTime) {
            const startDate = new Date(stream.startTime);
            const displayTime = `<t:${Math.floor(startDate.getTime() / 1000)}:F>`;
            line = `${displayTime}\n**${title}**`;
          } else {
            line = `**${title}**`;
          }

          if (description) {
            line += `\n*${description}*`;
          }
          return line;
        });

        embed.setDescription(scheduleLines.join('\n\n'));
      }

      const message = await channel.send({ embeds: [embed] });
      scheduleMessageIds.push(message.id);

      console.log('Schedule updated successfully');
      res.json({ success: true, messageId: message.id });

    } catch (error) {
      console.error('Error posting schedule:', error);
      res.status(500).json({ error: 'Failed to post schedule' });
    }
  });

  app.post('/rules', async (req, res) => {
    // Verify API key
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== WEBHOOK_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { title, rules, color, footer } = req.body;

    if (!rules || !Array.isArray(rules)) {
      return res.status(400).json({ error: 'Invalid payload. Expected { rules: [...] }' });
    }

    try {
      const channel = await client.channels.fetch(RULES_CHANNEL_ID);
      if (!channel) {
        return res.status(404).json({ error: 'Rules channel not found' });
      }

      // Clear old rules messages
      if (rulesMessageIds.length > 0) {
        try {
          await channel.bulkDelete(rulesMessageIds);
        } catch (err) {
          for (const msgId of rulesMessageIds) {
            try {
              const msg = await channel.messages.fetch(msgId);
              await msg.delete();
            } catch (e) {
              // Message might already be deleted
            }
          }
        }
        rulesMessageIds = [];
      }

      // Create rules embed
      const embed = new EmbedBuilder()
        .setColor(color || 0xff5555)
        .setTitle(title || 'Server Rules')
        .setTimestamp();

      const rulesText = rules.map((rule, index) => {
        if (typeof rule === 'string') {
          return `**${index + 1}.** ${rule}`;
        }
        // Support object format with title and description
        let line = `**${index + 1}. ${rule.title || 'Rule'}**`;
        if (rule.description) {
          line += `\n${rule.description}`;
        }
        return line;
      }).join('\n\n');

      embed.setDescription(rulesText);

      if (footer) {
        embed.setFooter({ text: footer });
      }

      const message = await channel.send({ embeds: [embed] });
      rulesMessageIds.push(message.id);

      console.log('Rules updated successfully');
      res.json({ success: true, messageId: message.id });

    } catch (error) {
      console.error('Error posting rules:', error);
      res.status(500).json({ error: 'Failed to post rules' });
    }
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', bot: client.user?.tag });
  });

  app.listen(WEBHOOK_PORT, () => {
    console.log(`Webhook server listening on port ${WEBHOOK_PORT}`);
  });
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'whereisryan') {
    await interaction.deferReply();

    try {
      const response = await fetch(VATSIM_DATA_URL);
      if (!response.ok) {
        throw new Error(`VATSIM API returned ${response.status}`);
      }

      const data = await response.json();
      const pilot = data.pilots.find(p => p.cid.toString() === VATSIM_CID);

      if (!pilot) {
        const embed = new EmbedBuilder()
          .setColor(0xff6b6b)
          .setTitle('Not Online')
          .setDescription(`Pilot with CID **${VATSIM_CID}** is not currently flying on VATSIM.`)
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // Calculate flight time if available
      const logonTime = new Date(pilot.logon_time);
      const now = new Date();
      const flightTimeMs = now - logonTime;
      const hours = Math.floor(flightTimeMs / (1000 * 60 * 60));
      const minutes = Math.floor((flightTimeMs % (1000 * 60 * 60)) / (1000 * 60));
      const flightTimeStr = `${hours}h ${minutes}m`;

      // Build the embed
      const embed = new EmbedBuilder()
        .setColor(0x00d26a)
        .setTitle(`${pilot.callsign}`)
        .setDescription(`Pilot CID: **${pilot.cid}** is currently online!`)
        .addFields(
          {
            name: 'Route',
            value: pilot.flight_plan
              ? `${pilot.flight_plan.departure || 'N/A'} -> ${pilot.flight_plan.arrival || 'N/A'}`
              : 'No flight plan filed',
            inline: false
          },
          {
            name: 'Aircraft',
            value: pilot.flight_plan?.aircraft_short || pilot.flight_plan?.aircraft_faa || 'Unknown',
            inline: true
          },
          {
            name: 'Altitude',
            value: `${pilot.altitude.toLocaleString()} ft`,
            inline: true
          },
          {
            name: 'Ground Speed',
            value: `${pilot.groundspeed} kts`,
            inline: true
          },
          {
            name: 'Heading',
            value: `${pilot.heading}°`,
            inline: true
          },
          {
            name: 'Transponder',
            value: pilot.transponder || 'N/A',
            inline: true
          },
          {
            name: 'Flight Time',
            value: flightTimeStr,
            inline: true
          }
        )
        .setTimestamp();

      // Add cruise altitude if flight plan exists
      if (pilot.flight_plan?.altitude) {
        embed.addFields({
          name: 'Filed Altitude',
          value: pilot.flight_plan.altitude,
          inline: true
        });
      }

      // Add route if available
      if (pilot.flight_plan?.route) {
        const route = pilot.flight_plan.route.length > 200
          ? pilot.flight_plan.route.substring(0, 200) + '...'
          : pilot.flight_plan.route;
        embed.addFields({
          name: 'Filed Route',
          value: route || 'N/A',
          inline: false
        });
      }

      // Add position
      embed.setFooter({
        text: `Position: ${pilot.latitude.toFixed(4)}, ${pilot.longitude.toFixed(4)}`
      });

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Error fetching VATSIM data:', error);

      const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle('Error')
        .setDescription('Failed to fetch VATSIM data. Please try again later.')
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }
  }

  // Verify command - link Discord to VATSIM
  if (interaction.commandName === 'verify') {
    await interaction.deferReply({ ephemeral: true });

    try {
      // Get VATSIM CID from Discord ID
      const cid = await getVatsimCidFromDiscord(interaction.user.id);

      if (!cid) {
        const embed = new EmbedBuilder()
          .setColor(0xff6b6b)
          .setTitle('Not Linked')
          .setDescription('Your Discord account is not linked to a VATSIM account.\n\nPlease link your account at [my.vatsim.net](https://my.vatsim.net) under **Settings > Discord**.')
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // Get member data and pilot stats
      const [memberData, pilotStats] = await Promise.all([
        getVatsimMemberData(cid),
        getVatsimPilotStats(cid)
      ]);

      // Assign roles
      const { rolesAdded, rolesRemoved, totalHours } = await assignVatsimRoles(
        interaction.member,
        cid,
        memberData,
        pilotStats
      );

      const embed = new EmbedBuilder()
        .setColor(0x00d26a)
        .setTitle('Verification Successful')
        .setDescription(`Your Discord account has been linked to VATSIM CID **${cid}**.`)
        .addFields(
          { name: 'Name', value: `${memberData.name_first} ${memberData.name_last}`, inline: true },
          { name: 'ATC Rating', value: ATC_RATINGS[memberData.rating] || 'Unknown', inline: true },
          { name: 'Pilot Rating', value: PILOT_RATINGS[memberData.pilotrating] || 'Unknown', inline: true },
          { name: 'Pilot Hours', value: `${totalHours.toFixed(1)} hours`, inline: true }
        )
        .setTimestamp();

      if (rolesAdded.length > 0) {
        embed.addFields({ name: 'Roles Added', value: rolesAdded.join(', '), inline: false });
      }

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Error in verify command:', error);

      const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle('Error')
        .setDescription('An error occurred while verifying your account. Please try again later.')
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }
  }

  // Sync roles command - re-sync VATSIM roles
  if (interaction.commandName === 'syncroles') {
    await interaction.deferReply({ ephemeral: true });

    try {
      // Get VATSIM CID from Discord ID
      const cid = await getVatsimCidFromDiscord(interaction.user.id);

      if (!cid) {
        const embed = new EmbedBuilder()
          .setColor(0xff6b6b)
          .setTitle('Not Verified')
          .setDescription('You need to verify first using `/verify`.')
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // Get member data and pilot stats
      const [memberData, pilotStats] = await Promise.all([
        getVatsimMemberData(cid),
        getVatsimPilotStats(cid)
      ]);

      // Assign roles
      const { rolesAdded, rolesRemoved, totalHours } = await assignVatsimRoles(
        interaction.member,
        cid,
        memberData,
        pilotStats
      );

      const embed = new EmbedBuilder()
        .setColor(0x00d26a)
        .setTitle('Roles Synced')
        .setDescription(`Your roles have been updated based on your VATSIM data.`)
        .addFields(
          { name: 'ATC Rating', value: ATC_RATINGS[memberData.rating] || 'Unknown', inline: true },
          { name: 'Pilot Rating', value: PILOT_RATINGS[memberData.pilotrating] || 'Unknown', inline: true },
          { name: 'Pilot Hours', value: `${totalHours.toFixed(1)} hours`, inline: true }
        )
        .setTimestamp();

      if (rolesAdded.length > 0) {
        embed.addFields({ name: 'Roles Added', value: rolesAdded.join(', '), inline: false });
      }
      if (rolesRemoved.length > 0) {
        embed.addFields({ name: 'Roles Removed', value: rolesRemoved.join(', '), inline: false });
      }

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Error in syncroles command:', error);

      const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle('Error')
        .setDescription('An error occurred while syncing your roles. Please try again later.')
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }
  }
});

// Validate required environment variables
if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment variables');
  process.exit(1);
}

if (!VATSIM_CID) {
  console.error('Missing VATSIM_CID in environment variables');
  process.exit(1);
}

if (!SCHEDULE_CHANNEL_ID) {
  console.warn('Warning: SCHEDULE_CHANNEL_ID not set. Schedule webhook will not work.');
}

if (!WEBHOOK_API_KEY) {
  console.warn('Warning: WEBHOOK_API_KEY not set. Schedule webhook will not work.');
}

client.login(process.env.DISCORD_TOKEN);
