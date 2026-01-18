require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('whereisryan')
    .setDescription('Check where Ryan is currently flying on VATSIM')
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    );

    console.log('Successfully registered application commands globally.');
    console.log('Note: Global commands may take up to 1 hour to propagate.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

// Validate required environment variables
if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment variables');
  process.exit(1);
}

if (!process.env.DISCORD_CLIENT_ID) {
  console.error('Missing DISCORD_CLIENT_ID in environment variables');
  process.exit(1);
}

registerCommands();
