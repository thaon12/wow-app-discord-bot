/**
 * kek-db.js
 *
 * Shared SQLite layer for kek tracking. Both the bot and the backfill open the
 * same file. WAL mode lets them read and write at the same time, which is what
 * the old two-JSON-file split was working around.
 *
 * One row per (message, giver), with the message's author alongside. The
 * timestamp isn't stored, since a Discord ID is a snowflake with the creation
 * time inside it. See msOf().
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, 'keks.db');

const db = new Database(DB_FILE);

// WAL: readers don't block the writer and vice versa, so /stars stays responsive
// while a backfill is running.
db.pragma('journal_mode = WAL');
// NORMAL trades a tiny crash window for far fewer SD card syncs.
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS keks (
    message_id TEXT NOT NULL,
    giver_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    author_id  TEXT,
    PRIMARY KEY (message_id, giver_id)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_keks_giver   ON keks(giver_id);
  CREATE INDEX IF NOT EXISTS idx_keks_channel ON keks(channel_id);

  CREATE TABLE IF NOT EXISTS progress (
    channel_id TEXT PRIMARY KEY,
    cursor     TEXT,
    done       INTEGER NOT NULL DEFAULT 0,
    size       INTEGER
  );
`);

// Migration: a database created before author_id existed gets the column added
// rather than rebuilt. Rows written earlier keep a NULL author.
const cols = db.prepare('PRAGMA table_info(keks)').all().map((c) => c.name);
if (!cols.includes('author_id')) {
  db.exec('ALTER TABLE keks ADD COLUMN author_id TEXT');
}

// ─── Snowflakes ──────────────────────────────────────────────────────────────

const DISCORD_EPOCH = 1420070400000n;

/** Creation time in ms for any Discord ID. */
function msOf(id) {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** Lowest ID that could exist at a given time. Useful as a range bound. */
function idAt(ms) {
  return String((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n);
}

// ─── Statements ──────────────────────────────────────────────────────────────
// INSERT OR IGNORE makes writes idempotent: re-walking a page after a crash,
// or the bot and backfill both seeing the same reaction, can't double count.

const stmts = {
  addKek: db.prepare(
    'INSERT OR IGNORE INTO keks (message_id, giver_id, channel_id, author_id) VALUES (?, ?, ?, ?)'
  ),
  removeKek: db.prepare('DELETE FROM keks WHERE message_id = ? AND giver_id = ?'),

  countFor: db.prepare('SELECT COUNT(*) AS n FROM keks WHERE giver_id = ?'),
  topGivers: db.prepare(
    'SELECT giver_id, COUNT(*) AS n FROM keks GROUP BY giver_id ORDER BY n DESC LIMIT ?'
  ),
  totalKeks: db.prepare('SELECT COUNT(*) AS n FROM keks'),

  getProgress: db.prepare('SELECT * FROM progress WHERE channel_id = ?'),
  allProgress: db.prepare('SELECT * FROM progress'),
  setCursor: db.prepare(
    `INSERT INTO progress (channel_id, cursor) VALUES (?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET cursor = excluded.cursor`
  ),
  setDone: db.prepare(
    `INSERT INTO progress (channel_id, done) VALUES (?, 1)
     ON CONFLICT(channel_id) DO UPDATE SET done = 1`
  ),
  setSize: db.prepare(
    `INSERT INTO progress (channel_id, size) VALUES (?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET size = excluded.size`
  ),
};

/**
 * Write a page's keks and advance that channel's cursor together. If the
 * process dies mid-page nothing is committed, so the resume re-walks the page
 * and the primary key absorbs the repeats.
 */
const commitPage = db.transaction((rows, channelId, cursor) => {
  for (const row of rows) stmts.addKek.run(row.messageId, row.giverId, row.channelId, row.authorId);
  stmts.setCursor.run(channelId, cursor);
});

module.exports = { db, stmts, commitPage, msOf, idAt, DB_FILE };
