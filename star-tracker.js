/**
 * star-tracker.js
 *
 * Live kek counting for the main bot. Reads and writes keks.db, shared with the
 * backfill. Merge into index.js, or require it and call attachStarTracker(client).
 *
 * Two changes are needed in your existing client construction:
 *
 *   const { Client, GatewayIntentBits, Partials } = require('discord.js');
 *   const client = new Client({
 *     intents: [
 *       GatewayIntentBits.Guilds,
 *       GatewayIntentBits.GuildMessages,
 *       GatewayIntentBits.GuildMessageReactions,   // <- add
 *     ],
 *     partials: [Partials.Message, Partials.Channel, Partials.Reaction], // <- add
 *   });
 *
 * Partials matter here. Without them, reactions on messages that aren't in the
 * bot's cache (which is most of them) never fire the event at all.
 */

const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { stmts } = require('./kek-db');

const STAR_EMOJI_ID = process.env.STAR_EMOJI_ID;
const COUNT_SELF_STARS = false;

// ─── Storage ─────────────────────────────────────────────────────────────────
// Everything lives in keks.db, shared with the backfill. WAL mode means both
// processes can work at once, so there's nothing to merge and nothing to clobber.
// One row per (message, giver); the message timestamp comes from its snowflake.

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handle(reaction, user, added) {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    if (reaction.emoji.id !== STAR_EMOJI_ID) return;

    const msg = reaction.message;
    const authorId = msg.author ? msg.author.id : null;
    if (!COUNT_SELF_STARS && user.id === authorId) return;

    if (added) stmts.addKek.run(msg.id, user.id, msg.channelId, authorId);
    else stmts.removeKek.run(msg.id, user.id);
  } catch (err) {
    console.error('kek tracker:', err.message);
  }
}

function attachStarTracker(client) {
  client.on('messageReactionAdd', (reaction, user) => handle(reaction, user, true));
  client.on('messageReactionRemove', (reaction, user) => handle(reaction, user, false));
}

// ─── Slash command ───────────────────────────────────────────────────────────
// Register this in deploy-commands.js alongside your existing ones.

const starsCommand = new SlashCommandBuilder()
  .setName('stars')
  .setDescription('Show kek counts')
  .addSubcommand((sub) =>
    sub
      .setName('user')
      .setDescription('Keks given by one person')
      .addUserOption((opt) => opt.setName('target').setDescription('Who to look up').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('top').setDescription('Leaderboard of the biggest kek givers')
  )
  .addSubcommand((sub) =>
    sub
      .setName('inspect')
      .setDescription('Who someone keks, and who keks them')
      .addUserOption((opt) => opt.setName('target').setDescription('Who to inspect').setRequired(false))
  );

async function handleStarsCommand(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'user') {
    const target = interaction.options.getUser('target') || interaction.user;
    const given = stmts.countFor.get(target.id).n;

    const embed = new EmbedBuilder()
      .setTitle(target.username)
      .setThumbnail(target.displayAvatarURL())
      .addFields({ name: 'Keks given', value: String(given), inline: true })
      .setColor(0xf1c40f);

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'top') {
    const top = stmts.topGivers.all(20).map((r) => [r.giver_id, r.n]);

    if (!top.length) {
      await interaction.reply({ content: 'No keks recorded yet.', ephemeral: true });
      return;
    }

    const line = ([id, n], i) => `**${i + 1}.** <@${id}> \u2014 ${n}`;

    // Two inline fields sit side by side, 1-10 on the left and 11-20 on the
    // right. The second field only exists once there are more than 10 people.
    const fields = [
      { name: '\u200b', value: top.slice(0, 10).map(line).join('\n'), inline: true },
    ];
    if (top.length > 10) {
      fields.push({
        name: '\u200b',
        value: top.slice(10, 20).map((entry, i) => line(entry, i + 10)).join('\n'),
        inline: true,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('Top kek givers')
      .addFields(fields)
      .setColor(0xf1c40f);

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'inspect') {
    const target = interaction.options.getUser('target') || interaction.user;

    const givenTotal = stmts.countFor.get(target.id).n;
    const gotTotal = stmts.receivedTotal.get(target.id).n;

    const gaveTo = stmts.gaveTo.all(target.id, 10);
    const gotFrom = stmts.receivedFrom.all(target.id, 10);

    if (!givenTotal && !gotTotal) {
      await interaction.reply({ content: `No keks recorded for ${target.username}.`, ephemeral: true });
      return;
    }

    // Percentages are of that person's own total, so each column sums to at
    // most 100 and the two columns are independent of each other.
    const fmt = (rows, total) =>
      rows.length
        ? rows
            .map((r, i) => `**${i + 1}.** <@${r.id}> \u2014 ${r.n} (${((r.n / total) * 100).toFixed(1)}%)`)
            .join('\n')
        : '\u2014';

    const embed = new EmbedBuilder()
      .setTitle(`Kek profile: ${target.username}`)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: `Keks most \u2014 ${givenTotal} given`, value: fmt(gaveTo, givenTotal), inline: true },
        { name: `Top supporters \u2014 ${gotTotal} received`, value: fmt(gotFrom, gotTotal), inline: true }
      )
      .setColor(0xf1c40f);

    await interaction.reply({ embeds: [embed] });
    return;
  }
}

module.exports = { attachStarTracker, starsCommand, handleStarsCommand };
