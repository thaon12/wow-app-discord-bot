/**
 * star-tracker.js
 *
 * Live star counting for the main bot. Writes star-live.json and reads
 * star-backfill.json, so it never collides with a running backfill.
 * Merge into index.js, or require it and call attachStarTracker(client).
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
// The live tracker is the only writer of this file. The backfill owns
// star-backfill.json. Splitting them means neither can clobber the other.
const COUNTS_FILE = path.join(__dirname, 'star-live.json');
const BACKFILL_FILE = path.join(__dirname, 'star-backfill.json');
const COUNT_SELF_STARS = false;

// ─── Storage ─────────────────────────────────────────────────────────────────
// Live counts only. Historical counts come from the backfill file at read time.
// If this ever gets write-heavy, swap the two functions for better-sqlite3.

function load() {
  if (!fs.existsSync(COUNTS_FILE)) return { given: {} };
  const data = JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf8'));
  data.given = data.given || {};
  return data;
}

let counts = load();
let dirty = false;

// Backfill totals, re-read when the file changes on disk so a finished run
// shows up without a bot restart.
let backfillCache = { mtime: 0, given: {} };

function backfillGiven() {
  try {
    const stat = fs.statSync(BACKFILL_FILE);
    if (stat.mtimeMs !== backfillCache.mtime) {
      const data = JSON.parse(fs.readFileSync(BACKFILL_FILE, 'utf8'));
      backfillCache = { mtime: stat.mtimeMs, given: data.given || {} };
    }
  } catch {
    backfillCache = { mtime: 0, given: {} };
  }
  return backfillCache.given;
}

/** Live plus historical, merged per user. */
function totals() {
  const merged = { ...backfillGiven() };
  for (const [id, n] of Object.entries(counts.given)) {
    merged[id] = (merged[id] || 0) + n;
  }
  return merged;
}

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
  .setDescription('Show kek counts')
  .addSubcommand((sub) =>
    sub
      .setName('user')
      .setDescription('Keks given by one person')
      .addUserOption((opt) => opt.setName('target').setDescription('Who to look up').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('top').setDescription('Leaderboard of the biggest kek givers')
  );

async function handleStarsCommand(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'user') {
    const target = interaction.options.getUser('target') || interaction.user;
    const given = totals()[target.id] || 0;

    const embed = new EmbedBuilder()
      .setTitle(target.username)
      .setThumbnail(target.displayAvatarURL())
      .addFields({ name: 'Keks given', value: String(given), inline: true })
      .setColor(0xf1c40f);

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'top') {
    const top = Object.entries(totals()).sort((a, b) => b[1] - a[1]).slice(0, 20);

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
}

module.exports = { attachStarTracker, starsCommand, handleStarsCommand };
