/**
 * backfill-stars.js
 *
 * Walks guild message history and counts how many times each user has given
 * the star reaction. Standalone: run this separately from the bot, not inside
 * the pm2 process.
 *
 * Setup:
 *   1. Put STAR_EMOJI_ID and GUILD_ID in your .env
 *   2. node backfill-stars.js --channel=<id>     # test on one channel first
 *   3. node backfill-stars.js                    # full run
 *
 * Flags:
 *   --channel=<id>     limit to a single channel
 *   --inflight=<n>     max simultaneous Discord requests (default 10)
 *   --channels=<n>     channels walked in parallel (default 3)
 *
 * Progress is written to star-backfill.json, so a crash or a reboot resumes
 * where it left off. Delete that file to start over.
 */

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Options, ChannelType, PermissionsBitField } = require('discord.js');
require('dotenv').config();

// ─── Config ──────────────────────────────────────────────────────────────────

const STAR_EMOJI_ID = process.env.STAR_EMOJI_ID;
const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.BOT_TOKEN;

// Its own file. The live tracker owns star-live.json and never touches this
// one, so the two processes can't overwrite each other. /stars sums both.
const PROGRESS_FILE = path.join(__dirname, 'star-backfill.json');
const COUNT_SELF_STARS = false; // set true to count starring your own message
const COUNT_BOT_REACTORS = false;

const args = process.argv.slice(2);
const flag = (name, def) => {
  const raw = (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
  return raw === undefined ? def : raw;
};

const onlyChannel = flag('channel', null);

// Discord allows 50 requests/sec globally. At roughly 300ms round trip from a
// Pi, 10 in flight lands near 30/sec, which leaves headroom for the bot process
// sharing the same token. discord.js queues and backs off on 429s regardless,
// so overshooting costs throughput rather than correctness.
const MAX_INFLIGHT = Number(flag('inflight', 10));
const CHANNEL_CONCURRENCY = Number(flag('channels', 3));

if (!STAR_EMOJI_ID || !GUILD_ID || !TOKEN) {
  console.error('Missing STAR_EMOJI_ID, GUILD_ID or BOT_TOKEN in .env');
  process.exit(1);
}

// ─── Concurrency ─────────────────────────────────────────────────────────────

let inflight = 0;
const waiting = [];

/** Gate every Discord request through one global cap. */
async function limited(fn) {
  if (inflight >= MAX_INFLIGHT) await new Promise((resolve) => waiting.push(resolve));
  inflight++;
  try {
    return await fn();
  } finally {
    inflight--;
    const next = waiting.shift();
    if (next) next();
  }
}

/** Run fn over items with at most `concurrency` active at once. */
async function pMap(items, fn, concurrency) {
  const iter = items[Symbol.iterator]();
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (let next = iter.next(); !next.done; next = iter.next()) {
      await fn(next.value);
    }
  });
  await Promise.all(workers);
}

// ─── Progress ────────────────────────────────────────────────────────────────

let progress = {
  given: {},     // userId -> count of stars they gave
  cursors: {},   // channelId -> oldest message id processed so far
  done: [],      // channelIds fully walked
  scanned: 0,    // messages enumerated
  starred: 0,    // messages with at least one star
  sizes: {},     // channelId -> estimated message count, cached across resumes
};

if (fs.existsSync(PROGRESS_FILE)) {
  progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  console.log(`Resuming: ${progress.scanned.toLocaleString()} messages scanned, ${progress.done.length} channels done.`);
}

const startScanned = progress.scanned;

// Throttled so faster scanning doesn't turn into constant SD card writes.
let lastSave = 0;
let saveQueued = false;

function saveProgress(force = false) {
  const now = Date.now();
  if (!force && now - lastSave < 5000) {
    saveQueued = true;
    return;
  }
  lastSave = now;
  saveQueued = false;
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

setInterval(() => {
  if (saveQueued) saveProgress(true);
}, 5000).unref();

process.on('SIGINT', () => {
  console.log('\nInterrupted, saving progress.');
  saveProgress(true);
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

// ─── Size estimation ─────────────────────────────────────────────────────────
// Discord exposes no message count for a text channel, so the denominator has
// to be estimated. Channel lifetime alone is a bad proxy: a channel made last
// year can hold far more than a dead one from 2019. Instead we sample message
// density at points across each channel's history and extrapolate. Threads are
// exact, since Discord does expose a count on those.

const DISCORD_EPOCH = 1420070400000n;
// Tested against simulated bursty channels: 4 probes was off by ~150%, 16 lands
// around ~30%. This only feeds the progress display; star counts are exact.
const PROBES = 16;

function snowflakeToMs(id) {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

function msToSnowflake(ms) {
  return String((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n);
}

async function estimateSize(channel) {
  // Threads carry a real count. Use it.
  const exact = channel.totalMessageSent ?? channel.messageCount;
  if (typeof exact === 'number') return exact;

  const created = channel.createdTimestamp || snowflakeToMs(channel.id);
  const now = Date.now();
  const span = Math.max(1, now - created);
  const segment = span / PROBES;

  let total = 0;
  let sawPartial = false;
  let partialMax = 0;

  const indices = Array.from({ length: PROBES }, (_, i) => i);
  await pMap(indices, async (i) => {
    const at = created + segment * (i + 0.5);
    let batch;
    try {
      batch = await limited(() => channel.messages.fetch({ limit: 100, around: msToSnowflake(at) }));
    } catch {
      return;
    }
    if (!batch.size) return;

    // A window that came back short means the channel is sparse here, so the
    // sample is the population rather than a density reading.
    if (batch.size < 100) {
      sawPartial = true;
      partialMax = Math.max(partialMax, batch.size);
      total += batch.size;
      return;
    }

    const stamps = [...batch.values()].map((m) => m.createdTimestamp);
    const windowMs = Math.max(1, Math.max(...stamps) - Math.min(...stamps));
    total += (batch.size / windowMs) * segment;
  }, 4);

  if (total === 0) return sawPartial ? partialMax : 0;
  return Math.round(total);
}

// ─── Progress reporting ──────────────────────────────────────────────────────

const runStart = Date.now();
let estimatedTotal = 0;
let channelsDone = 0;
let channelCount = 0;
const active = new Set();
let lastPrint = 0;

// Rolling window, so the displayed rate reflects now rather than an average
// dragged down by login and the sizing pass.
const samples = [];

function fmtDuration(ms) {
  if (!isFinite(ms) || ms < 0) return '?';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function printStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastPrint < 5000) return;
  lastPrint = now;

  samples.push({ t: now, n: progress.scanned });
  while (samples.length > 2 && now - samples[0].t > 60000) samples.shift();

  const first = samples[0];
  const windowMs = now - first.t;
  const perSec = windowMs > 1000
    ? (progress.scanned - first.n) / (windowMs / 1000)
    : (progress.scanned - startScanned) / Math.max(1, (now - runStart) / 1000);

  const pct = estimatedTotal ? Math.min(99.9, (progress.scanned / estimatedTotal) * 100) : 0;
  const remaining = Math.max(0, estimatedTotal - progress.scanned);
  const eta = perSec > 0 ? (remaining / perSec) * 1000 : NaN;

  const names = [...active].slice(0, 2).join(', ') + (active.size > 2 ? ` +${active.size - 2}` : '');

  console.log(
    `[${pct.toFixed(1).padStart(5)}%] ` +
    `ch ${channelsDone}/${channelCount} ${names} | ` +
    `${progress.scanned.toLocaleString()} / ~${estimatedTotal.toLocaleString()} msgs | ` +
    `${progress.starred.toLocaleString()} starred | ` +
    `${Math.round(perSec)}/s | elapsed ${fmtDuration(now - runStart)} | ETA ${fmtDuration(eta)}`
  );
}

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
    const users = await limited(() => reaction.users.fetch({ limit: 100, ...(after && { after }) }));
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

  active.add(channel.name);
  let before = progress.cursors[channel.id] || undefined;

  try {
    while (true) {
      let batch;
      try {
        batch = await limited(() => channel.messages.fetch({ limit: 100, ...(before && { before }) }));
      } catch (err) {
        console.warn(`  ! ${channel.name}: ${err.message}, skipping channel`);
        break;
      }

      if (!batch.size) break;

      // Enumeration has to stay sequential, since each page depends on the
      // previous cursor. The reactor lookups don't, and they're the bulk of
      // the requests, so fire them together.
      const starred = [...batch.values()]
        .map((msg) => ({ msg, star: msg.reactions.cache.get(STAR_EMOJI_ID) }))
        .filter((x) => x.star);

      progress.starred += starred.length;

      await pMap(starred, async ({ msg, star }) => {
        const authorId = msg.author ? msg.author.id : null; // only to skip self-stars
        const reactors = await fetchAllReactors(star);
        for (const userId of reactors) {
          if (!COUNT_SELF_STARS && userId === authorId) continue;
          progress.given[userId] = (progress.given[userId] || 0) + 1;
        }
      }, 8);

      progress.scanned += batch.size;
      before = batch.last().id;
      progress.cursors[channel.id] = before;
      saveProgress();
      printStatus();

      if (batch.size < 100) break;
    }

    progress.done.push(channel.id);
    saveProgress(true);
  } finally {
    active.delete(channel.name);
    channelsDone++;
  }
}

/** Active plus archived public threads hanging off a channel. */
async function collectThreads(channel) {
  const threads = [];
  try {
    const activeThreads = await limited(() => channel.threads.fetch());
    threads.push(...activeThreads.threads.values());

    let before;
    while (true) {
      const archived = await limited(() =>
        channel.threads.fetchArchived({ type: 'public', limit: 100, ...(before && { before }) })
      );
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
  console.log(`Up to ${MAX_INFLIGHT} requests in flight, ${CHANNEL_CONCURRENCY} channels at a time.\n`);

  const guild = await client.guilds.fetch(GUILD_ID);
  const me = await guild.members.fetchMe();
  const channels = await guild.channels.fetch();

  const targets = [...channels.values()].filter((c) => {
    if (!c) return false;
    if (onlyChannel && c.id !== onlyChannel) return false;
    const ok = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];
    return ok.includes(c.type) && canRead(c, me);
  });

  channelCount = targets.length;

  console.log(`Sizing ${targets.length} channels...`);
  await pMap(targets, async (c) => {
    if (progress.sizes[c.id] === undefined) {
      progress.sizes[c.id] = c.type === ChannelType.GuildForum ? 0 : await estimateSize(c);
    }
    estimatedTotal += progress.sizes[c.id];
  }, 4);
  saveProgress(true);

  console.log(`Estimated ~${estimatedTotal.toLocaleString()} messages across ${targets.length} channels.\n`);

  await pMap(targets, async (channel) => {
    if (channel.type !== ChannelType.GuildForum) {
      await walkChannel(channel);
    }

    const threads = await collectThreads(channel);
    if (threads.length) {
      channelCount += threads.length;
      for (const th of threads) {
        if (progress.sizes[th.id] === undefined) {
          progress.sizes[th.id] = await estimateSize(th);
        }
        estimatedTotal += progress.sizes[th.id];
      }
      for (const thread of threads) {
        if (canRead(thread, me)) await walkChannel(thread);
        else channelsDone++;
      }
    }
  }, CHANNEL_CONCURRENCY);

  printStatus(true);
  const mins = Math.round((Date.now() - runStart) / 60000);
  console.log(`\nFinished in ${mins} min. ${progress.scanned.toLocaleString()} messages, ${progress.starred.toLocaleString()} starred.`);

  const top = Object.entries(progress.given).sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log('\nTop 20 star givers:');
  for (const [userId, count] of top) console.log(`  ${count}\t${userId}`);

  saveProgress(true);
  client.destroy();
});

client.login(TOKEN);
