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
} = require('discord.js');
require('dotenv').config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

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
    .setPlaceholder('Tell us about your raiding history, guilds, etc.');

  const warcraftlogs = new TextInputBuilder()
    .setCustomId('warcraftlogs')
    .setLabel('Link to any relevant warcraftlogs.')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
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

  // Post the application as plain formatted text
  const applicationEmbed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .addFields(
      { name: 'Your name, class, and spec.', value: `\`\`\`${nameClassSpec}\`\`\`` },
      { name: 'Please describe your experience with WoW.', value: `\`\`\`${experience}\`\`\`` },
      { name: 'Link to any relevant warcraftlogs.', value: `\`\`\`${warcraftlogs}\`\`\`` },
    );

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CLOSE_BUTTON_ID)
      .setLabel('Close Ticket')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Secondary)
  );

  await ticketChannel.send({
    content: `Welcome <@${applicant.id}>! Thank you for the app - we'll respond as soon as possible!`,
    embeds: [applicationEmbed],
    components: [closeRow],
  });

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

  // Find the original application message (the one with the Close Ticket button)
  const messages = await channel.messages.fetch({ limit: 50 });
  const originalMsg = messages.find((m) =>
    m.components.some((row) => row.components.some((c) => c.customId === CLOSE_BUTTON_ID))
  );

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

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.BOT_TOKEN);
