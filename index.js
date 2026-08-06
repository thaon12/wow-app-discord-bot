const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  AttachmentBuilder,
  Partials,
} = require('discord.js');
require('dotenv').config();

const { attachStarTracker, handleStarsCommand } = require('./star-tracker');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  // Required so reactions on messages outside the cache still fire events.
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

attachStarTracker(client);

// ─── Constants ───────────────────────────────────────────────────────────────

const APPLY_BUTTON_ID = 'open_application';
const MODAL_ID = 'application_modal';
const CLOSE_BUTTON_ID = 'close_ticket';
const ARCHIVE_BUTTON_ID = 'archive_ticket';
const REOPEN_BUTTON_ID_PREFIX = 'reopen_ticket_';
const CLOSE_CONFIRM_BUTTON_ID = 'close_confirm';
const CLOSE_CANCEL_BUTTON_ID = 'close_cancel';
const ARCHIVE_CATEGORY_NAME = 'anniversary-trial-archive';

// ─── Ready ───────────────────────────────────────────────────────────────────

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ─── Interactions ─────────────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {

  // /setup command — posts the application panel
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
    await handleSetup(interaction);
    return;
  }

  // Apply button — opens the modal
  if (interaction.isButton() && interaction.customId === APPLY_BUTTON_ID) {
    await handleApplyButton(interaction);
    return;
  }

  // Modal submit — creates the ticket channel
  if (interaction.isModalSubmit() && interaction.customId === MODAL_ID) {
    await handleModalSubmit(interaction);
    return;
  }

  // Close button — show confirmation prompt
  if (interaction.isButton() && interaction.customId === CLOSE_BUTTON_ID) {
    await handleCloseConfirmPrompt(interaction);
    return;
  }

  // Close confirm button — actually close
  if (interaction.isButton() && interaction.customId === CLOSE_CONFIRM_BUTTON_ID) {
    await handleCloseTicket(interaction);
    return;
  }

  // Close cancel button — delete the confirmation message
  if (interaction.isButton() && interaction.customId === CLOSE_CANCEL_BUTTON_ID) {
    await interaction.message.delete();
    await interaction.deferUpdate();
    return;
  }

  // Archive button
  if (interaction.isButton() && interaction.customId === ARCHIVE_BUTTON_ID) {
    await handleArchive(interaction);
    return;
  }

  // Reopen ticket button
  if (interaction.isButton() && interaction.customId.startsWith(REOPEN_BUTTON_ID_PREFIX)) {
    await handleReopenTicket(interaction);
    return;
  }

  // /export_votes — exports poll results to CSV
  if (interaction.isChatInputCommand() && interaction.commandName === 'export_votes') {
    await handleExportVotes(interaction);
    return;
  }

  // /who_responded — list voters
  if (interaction.isChatInputCommand() && interaction.commandName === 'who_responded') {
    await handleWhoResponded(interaction);
    return;
  }

  // /missing — show who in a role didn't vote
  if (interaction.isChatInputCommand() && interaction.commandName === 'missing') {
    await handleMissing(interaction);
    return;
  }

  // /stars — star given/received counts
  if (interaction.isChatInputCommand() && interaction.commandName === 'stars') {
    await handleStarsCommand(interaction);
    return;
  }
});

// ─── /setup ──────────────────────────────────────────────────────────────────

async function handleSetup(interaction) {
  const isGM = process.env.GM_ROLE_ID && interaction.member.roles.cache.has(process.env.GM_ROLE_ID);
  if (!isGM) {
    await interaction.reply({ content: '❌ Only GMs can run this command.', flags: MessageFlags.Ephemeral });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Apply')
    .setDescription('To start the application, please click the button below.')
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(APPLY_BUTTON_ID)
      .setLabel('Apply')
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.reply({ content: '✅ Application panel posted!', flags: MessageFlags.Ephemeral });
  await interaction.channel.send({ embeds: [embed], components: [row] });
}

// ─── Apply button → open modal ───────────────────────────────────────────────

async function handleApplyButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle('Guild Application');

  const nameClassSpec = new TextInputBuilder()
    .setCustomId('name_class_spec')
    .setLabel('Your name, class, and spec.')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder('e.g. Soggy, Druid, Resto');

  const experience = new TextInputBuilder()
    .setCustomId('experience')
    .setLabel('Please describe your experience with WoW.')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1018)
    .setPlaceholder('Tell us about your raiding history, guilds, etc.');

  const warcraftlogs = new TextInputBuilder()
    .setCustomId('warcraftlogs')
    .setLabel('Link to any relevant warcraftlogs.')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1018)
    .setPlaceholder('https://www.warcraftlogs.com/...');

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameClassSpec),
    new ActionRowBuilder().addComponents(experience),
    new ActionRowBuilder().addComponents(warcraftlogs),
  );

  await interaction.showModal(modal);
}

// ─── Modal submit → create ticket channel ────────────────────────────────────

async function handleModalSubmit(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  const applicant = interaction.user;

  const nameClassSpec = interaction.fields.getTextInputValue('name_class_spec');
  const experience = interaction.fields.getTextInputValue('experience');
  const warcraftlogs = interaction.fields.getTextInputValue('warcraftlogs') || 'Not provided';

  // Build permission overwrites
  // Default: deny everyone
  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    // The applicant can see and send messages
    {
      id: applicant.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
  ];

  // GM role
  if (process.env.GM_ROLE_ID) {
    permissionOverwrites.push({
      id: process.env.GM_ROLE_ID,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  // Officer role
  if (process.env.OFFICER_ROLE_ID) {
    permissionOverwrites.push({
      id: process.env.OFFICER_ROLE_ID,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  // Use the name from the form (first word before comma), fall back to username
  const formName = nameClassSpec.split(',')[0].trim();
  const channelName = (formName || applicant.username).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  // Create the channel at the very top (position 0), outside any category
  let ticketChannel;
  try {
    ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      position: 0,
      permissionOverwrites,
    });
  } catch (err) {
    console.error('Failed to create ticket channel:', err);
    await interaction.editReply({ content: '❌ Something went wrong creating your ticket. Please contact an officer.' });
    return;
  }

  // Discord embed field values are capped at 1024 chars; wrap in code block (6 chars) = 1018 usable
  const truncate = (str, max = 1018) => str.length > max ? str.slice(0, max - 3) + '...' : str;

  // Post the application as plain formatted text
  const applicationEmbed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .addFields(
      { name: 'Your name, class, and spec.', value: `\`\`\`${truncate(nameClassSpec)}\`\`\`` },
      { name: 'Please describe your experience with WoW.', value: `\`\`\`${truncate(experience)}\`\`\`` },
      { name: 'Link to any relevant warcraftlogs.', value: `\`\`\`${truncate(warcraftlogs)}\`\`\`` },
    );

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CLOSE_BUTTON_ID)
      .setLabel('Close Ticket')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Secondary)
  );

  try {
    await ticketChannel.send({
      content: `Welcome <@${applicant.id}>! Thank you for the app - we'll respond as soon as possible!`,
      embeds: [applicationEmbed],
      components: [closeRow],
    });
  } catch (err) {
    console.error('Failed to post application message:', err);
    await interaction.editReply({ content: '❌ Your ticket was created but the application failed to post. Please contact an officer.' });
    return;
  }

  await interaction.editReply({
    content: `✅ Your application has been submitted! You can view it here: ${ticketChannel}`,
  });
}

// ─── Close confirmation prompt ─────────────────────────────────────────────────────

async function handleCloseConfirmPrompt(interaction) {
  const member = interaction.member;
  const isGM = process.env.GM_ROLE_ID && member.roles.cache.has(process.env.GM_ROLE_ID);
  const isOfficer = process.env.OFFICER_ROLE_ID && member.roles.cache.has(process.env.OFFICER_ROLE_ID);

  if (!isGM && !isOfficer) {
    await interaction.reply({ content: '❌ Only GMs and Officers can close tickets.', flags: MessageFlags.Ephemeral });
    return;
  }

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CLOSE_CONFIRM_BUTTON_ID)
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(CLOSE_CANCEL_BUTTON_ID)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.channel.send({
    content: 'Are you sure you would like to close the application?',
    components: [confirmRow],
  });
  await interaction.deferUpdate();
}

// ─── Close ticket ─────────────────────────────────────────────────────────────

async function handleCloseTicket(interaction) {
  const channel = interaction.channel;

  // Grab the applicant ID before removing their overwrite
  const applicantOverwrite = channel.permissionOverwrites.cache.find(
    (overwrite) => overwrite.type === 1 // 1 = member overwrite (not a role)
  );
  const applicantId = applicantOverwrite?.id;

  if (applicantOverwrite) {
    await channel.permissionOverwrites.delete(applicantOverwrite.id);
  }

  // Find the original application message — it's always the first message in the channel
  const firstMessages = await channel.messages.fetch({ limit: 1, after: '0' });
  const originalMsg = firstMessages.first() ?? null;

  // Replace Close Ticket button with Reopen + Archive
  const postCloseRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${REOPEN_BUTTON_ID_PREFIX}${applicantId ?? ''}`)
      .setLabel('Reopen Ticket')
      .setEmoji('🔓')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(ARCHIVE_BUTTON_ID)
      .setLabel('Archive')
      .setStyle(ButtonStyle.Primary),
  );

  if (originalMsg) {
    await originalMsg.edit({ components: [postCloseRow] });
  }

  const closedEmbed = new EmbedBuilder()
    .setDescription(`🔒 Application closed by <@${interaction.user.id}>`)
    .setColor(0x992d22)
    .setTimestamp();

  await interaction.message.delete();
  await channel.send({ embeds: [closedEmbed] });
  await interaction.deferUpdate();
}

// ─── Reopen ticket ────────────────────────────────────────────────────────────

async function handleReopenTicket(interaction) {
  const member = interaction.member;
  const isGM = process.env.GM_ROLE_ID && member.roles.cache.has(process.env.GM_ROLE_ID);
  const isOfficer = process.env.OFFICER_ROLE_ID && member.roles.cache.has(process.env.OFFICER_ROLE_ID);

  if (!isGM && !isOfficer) {
    await interaction.reply({ content: '❌ Only GMs and Officers can reopen tickets.', flags: MessageFlags.Ephemeral });
    return;
  }

  const applicantId = interaction.customId.slice(REOPEN_BUTTON_ID_PREFIX.length);
  const channel = interaction.channel;

  if (applicantId) {
    await channel.permissionOverwrites.edit(applicantId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
  }

  // Restore the Close Ticket button
  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CLOSE_BUTTON_ID)
      .setLabel('Close Ticket')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.message.edit({ components: [closeRow] });

  const reopenedEmbed = new EmbedBuilder()
    .setDescription(`🔓 Application reopened by <@${interaction.user.id}>`)
    .setColor(0x2ecc71)
    .setTimestamp();

  await channel.send({ embeds: [reopenedEmbed] });
  await interaction.deferUpdate();
}

// ─── Archive ticket ──────────────────────────────────────────────────────────────────────────────

async function handleArchive(interaction) {
  const guild = interaction.guild;
  const channel = interaction.channel;

  // Remove any remaining member-level permission overwrites (applicant)
  const memberOverwrites = channel.permissionOverwrites.cache.filter((o) => o.type === 1);
  for (const overwrite of memberOverwrites.values()) {
    await channel.permissionOverwrites.delete(overwrite.id);
  }

  // Find or create the archive category
  let archiveCategory = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === ARCHIVE_CATEGORY_NAME.toLowerCase()
  );

  if (!archiveCategory) {
    archiveCategory = await guild.channels.create({
      name: ARCHIVE_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
    });
  }

  await channel.setParent(archiveCategory.id, { lockPermissions: false });
  await interaction.deferUpdate();
}

// ─── Poll commands ───────────────────────────────────────────────────────────

function hasPollAccess(member) {
  const isGM = process.env.GM_ROLE_ID && member.roles.cache.has(process.env.GM_ROLE_ID);
  const isOfficer = process.env.OFFICER_ROLE_ID && member.roles.cache.has(process.env.OFFICER_ROLE_ID);
  return isGM || isOfficer;
}

async function fetchPollMessage(interaction, messageId) {
  let message;
  try {
    message = await interaction.channel.messages.fetch(messageId);
  } catch (err) {
    await interaction.editReply("❌ Couldn't find that message in this channel.");
    return null;
  }
  if (!message.poll) {
    await interaction.editReply("❌ That message doesn't have a poll on it.");
    return null;
  }
  return message;
}

async function getVotersPerAnswer(message) {
  const results = new Map();
  for (const [, answer] of message.poll.answers) {
    const voters = new Set();
    let after;
    while (true) {
      const batch = await answer.fetchVoters({ limit: 100, after });
      if (batch.size === 0) break;
      for (const [id] of batch) voters.add(id);
      if (batch.size < 100) break;
      after = batch.last().id;
    }
    const label = answer.text || `Answer ${answer.id}`;
    results.set(label, voters);
  }
  return results;
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function handleExportVotes(interaction) {
  if (!hasPollAccess(interaction.member)) {
    await interaction.reply({ content: '❌ Only GMs and Officers can use this command.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const messageId = interaction.options.getString('message_id');
  const message = await fetchPollMessage(interaction, messageId);
  if (!message) return;

  const votersByAnswer = await getVotersPerAnswer(message);

  const rows = [['User ID', 'Username', 'Display Name', 'Vote']];
  for (const [answerText, userIds] of votersByAnswer) {
    for (const uid of userIds) {
      const member = await interaction.guild.members.fetch(uid).catch(() => null);
      if (member) {
        rows.push([uid, member.user.username, member.displayName, answerText]);
      } else {
        rows.push([uid, '(unknown)', '(unknown)', answerText]);
      }
    }
  }

  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  const file = new AttachmentBuilder(Buffer.from(csv, 'utf-8'), { name: 'poll_votes.csv' });
  await interaction.editReply({ content: '✅ Here are the poll results:', files: [file] });
}

async function handleWhoResponded(interaction) {
  if (!hasPollAccess(interaction.member)) {
    await interaction.reply({ content: '❌ Only GMs and Officers can use this command.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const messageId = interaction.options.getString('message_id');
  const message = await fetchPollMessage(interaction, messageId);
  if (!message) return;

  const votersByAnswer = await getVotersPerAnswer(message);
  const allVoters = new Set();
  for (const set of votersByAnswer.values()) {
    for (const id of set) allVoters.add(id);
  }

  if (allVoters.size === 0) {
    await interaction.editReply('Nobody has voted yet.');
    return;
  }

  const names = [];
  for (const uid of allVoters) {
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    names.push(member ? member.displayName : `User ${uid}`);
  }
  names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const text = `**${names.length} people voted:**\n` + names.map((n) => `- ${n}`).join('\n');
  if (text.length <= 2000) {
    await interaction.editReply(text);
  } else {
    const file = new AttachmentBuilder(Buffer.from(text, 'utf-8'), { name: 'responders.txt' });
    await interaction.editReply({ content: `${names.length} people voted (see attached):`, files: [file] });
  }
}

async function handleMissing(interaction) {
  if (!hasPollAccess(interaction.member)) {
    await interaction.reply({ content: '❌ Only GMs and Officers can use this command.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const messageId = interaction.options.getString('message_id');
  const message = await fetchPollMessage(interaction, messageId);
  if (!message) return;

  const role = interaction.options.getRole('role');

  const votersByAnswer = await getVotersPerAnswer(message);
  const voterIds = new Set();
  for (const set of votersByAnswer.values()) {
    for (const id of set) voterIds.add(id);
  }

  // Make sure the member cache is populated
  await interaction.guild.members.fetch();

  const missingMembers = role.members.filter((m) => !voterIds.has(m.id) && !m.user.bot);
  const missingArr = [...missingMembers.values()];

  if (missingArr.length === 0) {
    await interaction.editReply(`✅ Everyone in **${role.name}** has voted.`);
    return;
  }

  missingArr.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
  const lines = missingArr.map((m) => `- ${m.displayName}`);
  const text = `**${missingArr.length} people in ${role.name} haven't voted:**\n` + lines.join('\n');

  if (text.length <= 2000) {
    await interaction.editReply(text);
  } else {
    const file = new AttachmentBuilder(Buffer.from(text, 'utf-8'), { name: 'missing.txt' });
    await interaction.editReply({
      content: `${missingArr.length} people in ${role.name} haven't voted (see attached):`,
      files: [file],
    });
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.BOT_TOKEN);
