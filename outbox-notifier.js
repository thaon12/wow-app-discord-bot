/**
 * outbox-notifier.js
 *
 * When an Officer or GM reacts with 📤 (:outbox_tray:) on a message in the
 * outbox channel, DM the message's author to let them know their request has
 * been handled.
 *
 * Requires the Message Content intent (both in code and toggled on in the
 * Discord Developer Portal under Bot > Privileged Gateway Intents) — without
 * it, message.content comes back empty for messages the bot didn't author.
 */

const OUTBOX_CHANNEL_ID = '1474176992399065322';
const OUTBOX_EMOJI = '📤';

function hasAccess(member) {
  const isGM = process.env.GM_ROLE_ID && member.roles.cache.has(process.env.GM_ROLE_ID);
  const isOfficer = process.env.OFFICER_ROLE_ID && member.roles.cache.has(process.env.OFFICER_ROLE_ID);
  return isGM || isOfficer;
}

// Guards against DMing the author twice — e.g. two officers react, or one
// removes and re-adds the reaction. Cleared on restart; worst case then is
// one extra DM, which is harmless.
const notified = new Set();

async function handleReactionAdd(reaction, user) {
  try {
    if (user.bot) return;
    if (reaction.message.channelId !== OUTBOX_CHANNEL_ID) return;
    if (reaction.emoji.name !== OUTBOX_EMOJI) return;

    if (reaction.partial) await reaction.fetch();
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;

    if (notified.has(message.id)) return;

    const member = await message.guild.members.fetch(user.id).catch(() => null);
    if (!member || !hasAccess(member)) return;

    const author = message.author;
    if (!author || author.bot) return;

    notified.add(message.id);

    const quote = message.content
      ? message.content.split('\n').map((line) => `> ${line}`).join('\n')
      : '> *(no text content)*';
    const link = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;

    const dmText = `Your request has been completed. Allow for 1 hour for the request to arrive to your mailbox.\n\n${quote}\n\n${link}`;

    try {
      await author.send(dmText);
    } catch (err) {
      console.error(`outbox notifier: failed to DM ${author.id}:`, err.message);
      // Let the officer know the DM didn't go through, and allow a retry.
      await message.react('⚠️').catch(() => {});
      notified.delete(message.id);
    }

    // Always send a copy to the officer/GM who reacted, independent of
    // whether the author's DM above succeeded.
    try {
      await user.send(`Copy — sent to ${author.tag} (<@${author.id}>):\n\n${dmText}`);
    } catch (err) {
      console.error(`outbox notifier: failed to send copy to ${user.id}:`, err.message);
    }
  } catch (err) {
    console.error('outbox notifier:', err.message);
  }
}

function attachOutboxNotifier(client) {
  client.on('messageReactionAdd', (reaction, user) => handleReactionAdd(reaction, user));
}

module.exports = { attachOutboxNotifier };
