// Who is allowed to do what.
//
// Two separate checks, because they answer different questions:
//   canUseCommands  may this person start playback at all
//   canControl      may this person touch the panel of a running stream
//
// canControl is deliberately narrower: the person who started the episode can
// always control it, and anyone holding a role listed in ALLOWED_ROLE_IDS can
// too. Nobody else can, even with Manage Server.

/**
 * @param {import('discord.js').GuildMember} member
 * @param {string[]} roleIds
 */
export function hasAnyRole(member, roleIds) {
  if (!roleIds?.length) return false;
  if (!member?.roles?.cache) return false;
  return roleIds.some((id) => member.roles.cache.has(id));
}

/** May this member run /play, /resume and /np? */
export function canUseCommands(member, config) {
  // No allow list configured means the channel permissions decide.
  if (!config.allowedCommandRoleIds.length) return true;
  return hasAnyRole(member, config.allowedCommandRoleIds);
}

/**
 * May this member press a button on the panel?
 *
 * @param {object} p
 * @param {import('discord.js').GuildMember} p.member
 * @param {string|null} p.requesterId who started playback
 * @param {string[]} p.allowedRoleIds
 */
export function canManageStreamers({ member, ownerId, allowedRoleIds, allowedCommandRoleIds }) {
  if (!member) return false;
  if (ownerId && member.id === ownerId) return true;
  return hasAnyRole(member, allowedRoleIds) || hasAnyRole(member, allowedCommandRoleIds);
}

export function canControl({ member, requesterId, allowedRoleIds }) {
  if (!member) return false;
  if (requesterId && member.id === requesterId) return true;
  return hasAnyRole(member, allowedRoleIds);
}

/** The sentence shown when someone is refused. Names the real reason. */
export function refusalMessage({ requesterId, allowedRoleIds }) {
  const who = allowedRoleIds.length
    ? 'Only the person who started this stream, or a role allowed to control streams, can use these'
    : 'Only the person who started this stream can use these';
  return `${who} controls. This one belongs to <@${requesterId || 'unknown'}>.`;
}
