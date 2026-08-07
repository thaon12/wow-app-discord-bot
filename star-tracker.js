/**
 * star-tracker.js
 *
 * Live star counting for the main bot. Merge into index.js, or require it and
 * call attachStarTracker(client).
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

const fs = require('fs');
const path = require('path');
const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

const STAR_EMOJI_ID = process.env.STAR_EMOJI_ID;
const COUNTS_FILE = path.join(__dirname, 'star-progress.json');
const COUNT_SELF_STARS = false;

// ─── Storage ─────────────────────────────────────────────────────────────────
// Shares the file the backfill writes, so live counts stack on top of history.
// If this ever gets write-heavy, swap the two functions for better-sqlite3.

function load() {
  if (!fs.existsSync(COUNTS_FILE)) return { given: {} };
  const data = JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf8'));
  data.given = data.given || {};
  return data;
}

let counts = load();
let dirty = false;

function flush() {
  if (!dirty) return;
  fs.writeFileSync(COUNTS_FILE, JSON.stringify(counts, null, 2));
  dirty = false;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

function bump(map, id, delta) {
  const next = (map[id] || 0) + delta;
  if (next <= 0) delete map[id];
  else map[id] = next;
  dirty = true;
}

async function handle(reaction, user, delta) {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    if (reaction.emoji.id !== STAR_EMOJI_ID) return;

    const authorId = reaction.message.author ? reaction.message.author.id : null;
    if (!COUNT_SELF_STARS && user.id === authorId) return;

    bump(counts.given, user.id, delta);
  } catch (err) {
    console.error('star tracker:', err.message);
  }
}

function attachStarTracker(client) {
  client.on('messageReactionAdd', (reaction, user) => handle(reaction, user, 1));
  client.on('messageReactionRemove', (reaction, user) => handle(reaction, user, -1));

  // Batched writes so a reaction storm doesn't hammer the SD card. Started here
  // rather than at module load, so scripts that only import starsCommand (like
  // register.js) aren't held open by a live timer.
  const timer = setInterval(flush, 10_000);
  timer.unref();

  // Don't lose up to 10 seconds of counts on a pm2 restart.
  process.once('SIGINT', () => { flush(); process.exit(0); });
  process.once('SIGTERM', () => { flush(); process.exit(0); });
}

// ─── Slash command ───────────────────────────────────────────────────────────
// Register this in deploy-commands.js alongside your existing ones.

const starsCommand = new SlashCommandBuilder()
  .setName('stars')
  .setDescription('Show star counts')
  .addSubcommand((sub) =>
    sub
      .setName('user')
      .setDescription('Stars given by one person')
      .addUserOption((opt) => opt.setName('target').setDescription('Who to look up').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('top').setDescription('Leaderboard of the biggest star givers')
  );

async function handleStarsCommand(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'user') {
    const target = interaction.options.getUser('target') || interaction.user;
    const given = counts.given[target.id] || 0;

    const embed = new EmbedBuilder()
      .setTitle(target.username)
      .setThumbnail(target.displayAvatarURL())
      .addFields({ name: 'Stars given', value: String(given), inline: true })
      .setColor(0xf1c40f);

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'top') {
    const top = Object.entries(counts.given).sort((a, b) => b[1] - a[1]).slice(0, 10);

    if (!top.length) {
      await interaction.reply({ content: 'No stars recorded yet.', ephemeral: true });
      return;
    }

    const lines = top.map(([id, n], i) => `**${i + 1}.** <@${id}> \u2014 ${n}`);
    const embed = new EmbedBuilder()
      .setTitle('Top star givers')
      .setDescription(lines.join('\n'))
      .setColor(0xf1c40f);

    await interaction.reply({ embeds: [embed] });
    return;
  }
}

module.exports = { attachStarTracker, starsCommand, handleStarsCommand };
