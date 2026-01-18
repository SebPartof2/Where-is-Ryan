require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const VATSIM_DATA_URL = 'https://data.vatsim.net/v3/vatsim-data.json';
const VATSIM_CID = process.env.VATSIM_CID;

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

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

client.login(process.env.DISCORD_TOKEN);
