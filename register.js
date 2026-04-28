// register.js — run once to register slash commands with Discord
// Usage: node register.js
// Requires CLIENT_ID and BOT_TOKEN in your .env file
//
// Note: this REPLACES all existing global commands, so /setup is included
// to keep it registered.

const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Post the application panel'),
  new SlashCommandBuilder()
    .setName('export_votes')
    .setDescription('Export all poll votes to a CSV file')
    .addStringOption((opt) =>
      opt.setName('message_id').setDescription('The message ID of the poll').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('who_responded')
    .setDescription('List everyone who voted in a poll')
    .addStringOption((opt) =>
      opt.setName('message_id').setDescription('The message ID of the poll').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('missing')
    .setDescription("Show who in a role hasn't voted in a poll")
    .addStringOption((opt) =>
      opt.setName('message_id').setDescription('The message ID of the poll').setRequired(true),
    )
    .addRoleOption((opt) =>
      opt.setName('role').setDescription('The role to check against').setRequired(true),
    ),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

(async () => {
  if (!process.env.CLIENT_ID) {
    console.error('Error: CLIENT_ID missing from .env. Find it in Discord Developer Portal → your app → General Information → Application ID.');
    process.exit(1);
  }
  if (!process.env.BOT_TOKEN) {
    console.error('Error: BOT_TOKEN missing from .env.');
    process.exit(1);
  }

  try {
    console.log('Registering slash commands...');
    const data = await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands },
    );
    console.log(`✅ Successfully registered ${data.length} commands.`);
  } catch (err) {
    console.error(err);
  }
})();
