/**
 * archive-config.js
 *
 * /archive_category: lets a GM pick which category archived application
 * channels get moved into. The choice is saved per server in
 * archive-config.json (next to this file, gitignored) so it survives restarts.
 *
 * There is no default. Until one is set, the Archive button replies with a
 * message saying a GM needs to set one.
 */

const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');

const CONFIG_FILE = path.join(__dirname, 'archive-config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read archive-config.json:', err);
    return {};
  }
}

function saveConfig(config) {
  // Write to a temp file first, then rename, so a crash mid-write can't leave
  // a half-written config behind.
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

/** Returns the saved archive category ID for a server, or null. */
function getArchiveCategoryId(guildId) {
  return loadConfig()[guildId]?.archiveCategoryId ?? null;
}

const archiveCategoryCommand = new SlashCommandBuilder()
  .setName('archive_category')
  .setDescription('Set where archived applications go')
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Pick the category archived applications are moved into')
      .addChannelOption((opt) =>
        opt
          .setName('category')
          .setDescription('The archive category')
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('show').setDescription('Show the current archive category')
  );

async function handleArchiveCategoryCommand(interaction) {
  const isGM = process.env.GM_ROLE_ID && interaction.member.roles.cache.has(process.env.GM_ROLE_ID);
  if (!isGM) {
    await interaction.reply({ content: '❌ Only GMs can run this command.', flags: MessageFlags.Ephemeral });
    return;
  }

  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();
  const config = loadConfig();

  if (sub === 'set') {
    const category = interaction.options.getChannel('category', true);
    config[guildId] = { ...config[guildId], archiveCategoryId: category.id };
    saveConfig(config);
    await interaction.reply({
      content:
        `✅ Archived applications will now go to **${category.name}**.\n` +
        `If it fills up (Discord allows 50 channels per category), new ones go to **${category.name} 2**, **${category.name} 3**, and so on.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === 'show') {
    const id = config[guildId]?.archiveCategoryId;
    const category = id ? interaction.guild.channels.cache.get(id) : null;
    let content;
    if (!id) {
      content = 'No archive category is set, so applications can\'t be archived yet. Run `/archive_category set` to pick one.';
    } else if (!category) {
      content = 'The saved archive category was deleted. Run `/archive_category set` to pick a new one.';
    } else {
      content = `Archived applications go to **${category.name}**.`;
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

module.exports = { archiveCategoryCommand, handleArchiveCategoryCommand, getArchiveCategoryId };
