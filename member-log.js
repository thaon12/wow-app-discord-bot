/**
 * member-log.js
 *
 * Posts a log message when someone leaves the server. If they were kicked or
 * banned, a second line underneath says what happened and who did it.
 *
 * Needs in .env:
 *   MEMBER_LOG_CHANNEL_ID=<channel id to post in>
 *
 * Needs on the bot:
 *   - GuildMembers intent (already on in index.js)
 *   - "View Audit Log" permission in the server, so it can tell a kick from a leave
 *   - Partials.GuildMember and Partials.User, so members who aren't cached still fire
 */

const { EmbedBuilder, AuditLogEvent } = require('discord.js');

const LOG_CHANNEL_ID = process.env.MEMBER_LOG_CHANNEL_ID;

// Discord writes the audit log entry a moment after the member is removed,
// so wait a bit before looking it up.
const AUDIT_LOG_DELAY_MS = 2000;
// Only trust audit entries this recent, so an old kick of the same person
// doesn't get matched to a normal leave later on.
const AUDIT_LOG_MAX_AGE_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findModAction(guild, userId) {
  const checks = [
    { type: AuditLogEvent.MemberKick, label: 'Kick' },
    { type: AuditLogEvent.MemberBanAdd, label: 'Ban' },
  ];

  for (const { type, label } of checks) {
    try {
      const logs = await guild.fetchAuditLogs({ type, limit: 5 });
      const entry = logs.entries.find(
        (e) => e.targetId === userId && Date.now() - e.createdTimestamp < AUDIT_LOG_MAX_AGE_MS
      );
      if (entry) return { label, executor: entry.executor, executorId: entry.executorId };
    } catch (err) {
      // Usually means the bot is missing View Audit Log.
      console.error('member log: audit log fetch failed:', err.message);
      return null;
    }
  }
  return null;
}

async function handleMemberRemove(member) {
  try {
    if (!LOG_CHANNEL_ID) return;
    const channel = await member.client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!channel) {
      console.error('member log: MEMBER_LOG_CHANNEL_ID not found');
      return;
    }

    const user = member.user;

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setDescription(`**${user.tag} has left the server.**`)
      .addFields({ name: 'ID', value: user.id })
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .setTimestamp();

    await sleep(AUDIT_LOG_DELAY_MS);
    const action = await findModAction(member.guild, user.id);

    await channel.send({ embeds: [embed] });

    if (action) {
      const moderator = action.executor ? `<@${action.executorId}>` : 'Unknown';
      await channel.send({
        content: `**${action.label}**\n**Moderator**: ${moderator}`,
        allowedMentions: { parse: [] }, // show the name without pinging
      });
    }
  } catch (err) {
    console.error('member log:', err.message);
  }
}

function attachMemberLog(client) {
  client.on('guildMemberRemove', handleMemberRemove);
}

module.exports = { attachMemberLog };
