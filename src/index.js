require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const express = require('express');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const VATSIM_DATA_URL = 'https://data.vatsim.net/v3/vatsim-data.json';
const VATSIM_CID = process.env.VATSIM_CID;
const SCHEDULE_CHANNEL_ID = process.env.SCHEDULE_CHANNEL_ID;
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY;
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 4509;

// Store schedule message IDs for cleanup
let scheduleMessageIds = [];

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  startWebhookServer();
});

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
