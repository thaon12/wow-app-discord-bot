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
 * Progress and results go to keks.db. A crash or a reboot resumes where it left
 * off, and re-walked pages can't double count. Delete keks.db to start over.
 */

const { Client, GatewayIntentBits, Options, ChannelType, PermissionsBitField } = require('discord.js');
const { stmts, commitPage, msOf, idAt } = require('./kek-db');
require('dotenv').config();

// ─── Config ──────────────────────────────────────────────────────────────────

const STAR_EMOJI_ID = process.env.STAR_EMOJI_ID;
const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.BOT_TOKEN;

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

// Discord returns transient 5xx under load. Retrying with backoff turns a
// blip into a pause instead of losing the run.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 6;

async function withRetry(fn, label) {
  let wait = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = RETRY_STATUS.has(err.status) || err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN' || err.name === 'AbortError';
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      console.warn(`  ~ ${label}: ${err.status || err.code}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 60000);
    }
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
// Cursors, per-channel size estimates and the kek rows all live in keks.db.
// Nothing is held in memory that a crash would lose.

const rows = stmts.allProgress.all();
const doneChannels = new Set(rows.filter((r) => r.done).map((r) => r.channel_id));
const cursors = new Map(rows.filter((r) => r.cursor).map((r) => [r.channel_id, r.cursor]));
const sizes = new Map(rows.filter((r) => r.size != null).map((r) => [r.channel_id, r.size]));

// Display counters only. The database is the source of truth.
let scanned = 0;
let starred = 0;
const startKeks = stmts.totalKeks.get().n;

if (doneChannels.size || cursors.size) {
  console.log(`Resuming: ${doneChannels.size} channels done, ${startKeks.toLocaleString()} keks already recorded.`);
}

process.on('SIGINT', () => {
  console.log('\nInterrupted. Progress is committed up to the last completed page.');
  process.exit(0);
});

// discord.js emits 'error' on the client for some failures, which is fatal if
// unhandled. Log and keep going; the retry logic covers the recoverable cases.
process.on('unhandledRejection', (err) => {
  console.warn(`  ! unhandled: ${err && err.message}`);
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

// Tested against simulated bursty channels: 4 probes was off by ~150%, 16 lands
// around ~30%. This only feeds the progress display; kek counts are exact.
const PROBES = 16;

async function estimateSize(channel) {
  // Threads carry a real count. Use it.
  const exact = channel.totalMessageSent ?? channel.messageCount;
  if (typeof exact === 'number') return exact;

  const created = channel.createdTimestamp || msOf(channel.id);
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
      batch = await withRetry(
        () => limited(() => channel.messages.fetch({ limit: 100, around: idAt(at) })),
        `size probe ${channel.name}`
      );
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

  samples.push({ t: now, n: scanned });
  while (samples.length > 2 && now - samples[0].t > 60000) samples.shift();

  const first = samples[0];
  const windowMs = now - first.t;
  const perSec = windowMs > 1000
    ? (scanned - first.n) / (windowMs / 1000)
    : scanned / Math.max(1, (now - runStart) / 1000);

  const pct = estimatedTotal ? Math.min(99.9, (scanned / estimatedTotal) * 100) : 0;
  const remaining = Math.max(0, estimatedTotal - scanned);
  const eta = perSec > 0 ? (remaining / perSec) * 1000 : NaN;

  const names = [...active].slice(0, 2).join(', ') + (active.size > 2 ? ` +${active.size - 2}` : '');

  console.log(
    `[${pct.toFixed(1).padStart(5)}%] ` +
    `ch ${channelsDone}/${channelCount} ${names} | ` +
    `${scanned.toLocaleString()} / ~${estimatedTotal.toLocaleString()} msgs | ` +
    `${starred.toLocaleString()} kek'd | ` +
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
    const users = await withRetry(
      () => limited(() => reaction.users.fetch({ limit: 100, ...(after && { after }) })),
      `reactors ${reaction.message.id}`
    );
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
  if (doneChannels.has(channel.id)) return;

  active.add(channel.name);
  let before = cursors.get(channel.id) || undefined;

  try {
    while (true) {
      let batch;
      try {
        batch = await withRetry(
          () => limited(() => channel.messages.fetch({ limit: 100, ...(before && { before }) })),
          `messages ${channel.name}`
        );
      } catch (err) {
        console.warn(`  ! ${channel.name}: ${err.message}, skipping channel`);
        break;
      }

      if (!batch.size) break;

      // Enumeration has to stay sequential, since each page depends on the
      // previous cursor. The reactor lookups don't, and they're the bulk of
      // the requests, so fire them together.
      const starredMsgs = [...batch.values()]
        .map((msg) => ({ msg, star: msg.reactions.cache.get(STAR_EMOJI_ID) }))
        .filter((x) => x.star);

      starred += starredMsgs.length;

      const pageRows = [];
      await pMap(starredMsgs, async ({ msg, star }) => {
        try {
          const authorId = msg.author ? msg.author.id : null;
          const reactors = await fetchAllReactors(star);
          for (const userId of reactors) {
            if (!COUNT_SELF_STARS && userId === authorId) continue;
            pageRows.push({ messageId: msg.id, giverId: userId, channelId: channel.id, authorId });
          }
        } catch (err) {
          // One unreachable message shouldn't cost the whole run.
          console.warn(`  ! reactors ${msg.id}: ${err.message}, skipped`);
        }
      }, 8);

      scanned += batch.size;
      before = batch.last().id;

      // Rows and cursor commit together, so a crash mid-page rolls back to the
      // start of the page rather than leaving a half-recorded one.
      commitPage(pageRows, channel.id, before);
      cursors.set(channel.id, before);
      printStatus();

      if (batch.size < 100) break;
    }

    stmts.setDone.run(channel.id);
    doneChannels.add(channel.id);
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
    if (!sizes.has(c.id)) {
      const n = c.type === ChannelType.GuildForum ? 0 : await estimateSize(c);
      stmts.setSize.run(c.id, n);
      sizes.set(c.id, n);
    }
    estimatedTotal += sizes.get(c.id);
  }, 4);

  console.log(`Estimated ~${estimatedTotal.toLocaleString()} messages across ${targets.length} channels.\n`);

  await pMap(targets, async (channel) => {
    if (channel.type !== ChannelType.GuildForum) {
      await walkChannel(channel);
    }

    const threads = await collectThreads(channel);
    if (threads.length) {
      channelCount += threads.length;
      for (const th of threads) {
        if (!sizes.has(th.id)) {
          const n = await estimateSize(th);
          stmts.setSize.run(th.id, n);
          sizes.set(th.id, n);
        }
        estimatedTotal += sizes.get(th.id);
      }
      for (const thread of threads) {
        if (canRead(thread, me)) await walkChannel(thread);
        else channelsDone++;
      }
    }
  }, CHANNEL_CONCURRENCY);

  printStatus(true);
  const mins = Math.round((Date.now() - runStart) / 60000);
  const total = stmts.totalKeks.get().n;
  console.log(`\nFinished in ${mins} min. ${scanned.toLocaleString()} messages, ${starred.toLocaleString()} kek'd, ${total.toLocaleString()} kek rows.`);

  console.log('\nTop 20 kek givers:');
  for (const row of stmts.topGivers.all(20)) console.log(`  ${row.n}\t${row.giver_id}`);

  client.destroy();
});

// The 503 that killed an earlier run surfaced here as a fatal 'error' event.
client.on('error', (err) => console.warn(`  ! client error: ${err.message}`));

// Login gets its own retry with a longer ceiling. Discord throttles repeated
// connection attempts per token, so a restarted run can be refused at
// /gateway/bot for several minutes before it's let back in. Waiting is the
// only fix, and the script may as well do the waiting.
(async () => {
  let wait = 15000;
  for (let attempt = 1; ; attempt++) {
    try {
      await client.login(TOKEN);
      return;
    } catch (err) {
      if (attempt >= 10) {
        console.error(`Login failed after ${attempt} attempts: ${err.message}`);
        process.exit(1);
      }
      console.warn(`Login failed (${err.status || err.code || err.message}), retry ${attempt}/9 in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 300000);
    }
  }
})();
