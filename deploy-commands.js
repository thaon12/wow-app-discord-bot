/**
 * deploy-commands.js
 *
 * Registers every slash command with Discord for the guild in GUILD_ID.
 * Run once, and again any time a command or its options change:
 *
 *   node deploy-commands.js
 *
 * Discord replaces the entire guild command list on each run, so every command
 * the bot has must be in the array below. Removing one from here removes it
 * from the server.
 */

const { REST, Routes } = require('discord.js');
const { starsCommand } = require('./star-tracker');
const { SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Post the guild application panel in this channel'),

  new SlashCommandBuilder()
    .setName('export_votes')
    .setDescription('Export poll results to a CSV')
    .addStringOption((opt) =>
      opt.setName('message_id').setDescription('ID of the poll message').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('who_responded')
    .setDescription('List everyone who voted on a poll')
    .addStringOption((opt) =>
      opt.setName('message_id').setDescription('ID of the poll message').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('missing')
    .setDescription("Show who in a role didn't vote on a poll")
    .addStringOption((opt) =>
      opt.setName('message_id').setDescription('ID of the poll message').setRequired(true)
    )
    .addRoleOption((opt) =>
      opt.setName('role').setDescription('Role to check against').setRequired(true)
    ),

  starsCommand,
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

(async () => {
  try {
    console.log(`Registering ${commands.length} slash commands...`);
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Done. Registered: ' + commands.map((c) => '/' + c.name).join(', '));
  } catch (err) {
    console.error(err);
  }
})();
