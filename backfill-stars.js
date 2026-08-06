/**
 * backfill-stars.js
 *
 * Walks guild message history and counts how many times each user has given
 * (and received) the star reaction. Standalone: run this separately from the
 * bot, not inside the pm2 process.
 *
 * Setup:
 *   1. Put STAR_EMOJI_ID in your .env (get it by typing \:youremoji: in Discord)
 *   2. node backfill-stars.js --channel=<id>     # test on one channel first
 *   3. node backfill-stars.js                    # full run
 *
 * Progress is written to star-progress.json after every batch, so a crash or a
 * reboot resumes where it left off. Delete that file to start over.
 */

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Options, ChannelType, PermissionsBitField } = require('discord.js');
require('dotenv').config();

// ─── Config ──────────────────────────────────────────────────────────────────

const STAR_EMOJI_ID = process.env.STAR_EMOJI_ID;
const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.BOT_TOKEN;

const PROGRESS_FILE = path.join(__dirname, 'star-progress.json');
const COUNT_SELF_STARS = false; // set true to count starring your own message
const COUNT_BOT_REACTORS = false;

// --channel=<id> to limit the run to a single channel
const args = process.argv.slice(2);
const onlyChannel = (args.find((a) => a.startsWith('--channel=')) || '').split('=')[1] || null;

if (!STAR_EMOJI_ID || !GUILD_ID || !TOKEN) {
  console.error('Missing STAR_EMOJI_ID, GUILD_ID or BOT_TOKEN in .env');
  process.exit(1);
}

// ─── Progress ────────────────────────────────────────────────────────────────

let progress = {
  given: {},     // userId -> count of stars they gave
  received: {},  // userId -> count of stars their messages got
  cursors: {},   // channelId -> oldest message id processed so far
  done: [],      // channelIds fully walked
  scanned: 0,    // messages enumerated
  starred: 0,    // messages with at least one star
};

if (fs.existsSync(PROGRESS_FILE)) {
  progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  console.log(`Resuming: ${progress.scanned} messages already scanned, ${progress.done.length} channels done.`);
}

function saveProgress() {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// Flush on Ctrl-C so you never lose more than one batch.
process.on('SIGINT', () => {
  console.log('\nInterrupted, saving progress.');
  saveProgress();
  process.exit(0);
});

// ─── Client ──────────────────────────────────────────────────────────────────

// MessageManager: 0 is the important bit. Without it, paging through a few
// million messages will exhaust memory on the Pi long before the run finishes.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 0,
  }),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const READABLE = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory];

function canRead(channel, me) {
  const perms = channel.permissionsFor(me);
  return Boolean(perms && perms.has(READABLE));
}

/** Every reactor on a single message, paginated 100 at a time. */
async function fetchAllReactors(reaction) {
  const ids = [];
  let after;
  while (true) {
    const users = await reaction.users.fetch({ limit: 100, ...(after && { after }) });
    if (!users.size) break;
    for (const user of users.values()) {
      if (!COUNT_BOT_REACTORS && user.bot) continue;
      ids.push(user.id);
    }
    if (users.size < 100) break;
    after = users.last().id;
  }
  return ids;
}

/** Walk one channel or thread from its cursor backwards to the beginning. */
async function walkChannel(channel) {
  if (progress.done.includes(channel.id)) return;

  let before = progress.cursors[channel.id] || undefined;
  let batches = 0;

  while (true) {
    let batch;
    try {
      batch = await channel.messages.fetch({ limit: 100, ...(before && { before }) });
    } catch (err) {
      console.warn(`  ! ${channel.name}: ${err.message}, skipping channel`);
      progress.done.push(channel.id);
      saveProgress();
      return;
    }

    if (!batch.size) break;

    for (const msg of batch.values()) {
      const star = msg.reactions.cache.get(STAR_EMOJI_ID);
      if (!star) continue;

      progress.starred++;
      const authorId = msg.author ? msg.author.id : null;
      const reactors = await fetchAllReactors(star);

      for (const userId of reactors) {
        if (!COUNT_SELF_STARS && userId === authorId) continue;
        progress.given[userId] = (progress.given[userId] || 0) + 1;
        if (authorId) progress.received[authorId] = (progress.received[authorId] || 0) + 1;
      }
    }

    progress.scanned += batch.size;
    before = batch.last().id;
    progress.cursors[channel.id] = before;
    saveProgress();

    batches++;
    if (batches % 20 === 0) {
      console.log(`  ${channel.name}: ${progress.scanned} scanned, ${progress.starred} starred`);
    }

    if (batch.size < 100) break;
  }

  progress.done.push(channel.id);
  saveProgress();
  console.log(`  done: ${channel.name}`);
}

/** Active plus archived public threads hanging off a channel. */
async function collectThreads(channel) {
  const threads = [];
  try {
    const active = await channel.threads.fetch();
    threads.push(...active.threads.values());

    let before;
    while (true) {
      const archived = await channel.threads.fetchArchived({ type: 'public', limit: 100, ...(before && { before }) });
      threads.push(...archived.threads.values());
      if (!archived.hasMore || !archived.threads.size) break;
      before = archived.threads.last().archivedAt;
    }
  } catch (err) {
    console.warn(`  ! threads on ${channel.name}: ${err.message}`);
  }
  return threads;
}

// ─── Main ────────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const started = Date.now();

  const guild = await client.guilds.fetch(GUILD_ID);
  const me = await guild.members.fetchMe();
  const channels = await guild.channels.fetch();

  const targets = [...channels.values()].filter((c) => {
    if (!c) return false;
    if (onlyChannel && c.id !== onlyChannel) return false;
    const ok = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];
    return ok.includes(c.type) && canRead(c, me);
  });

  console.log(`Walking ${targets.length} channels.\n`);

  for (const channel of targets) {
    console.log(`# ${channel.name}`);

    // Forums hold no messages themselves, only threads.
    if (channel.type !== ChannelType.GuildForum) {
      await walkChannel(channel);
    }

    const threads = await collectThreads(channel);
    if (threads.length) console.log(`  ${threads.length} threads`);
    for (const thread of threads) {
      if (canRead(thread, me)) await walkChannel(thread);
    }
  }

  const mins = Math.round((Date.now() - started) / 60000);
  console.log(`\nFinished in ${mins} min. ${progress.scanned} messages, ${progress.starred} starred.`);

  const top = Object.entries(progress.given).sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log('\nTop 20 star givers:');
  for (const [userId, count] of top) console.log(`  ${count}\t${userId}`);

  saveProgress();
  client.destroy();
});

client.login(TOKEN);
