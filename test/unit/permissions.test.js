import test from 'node:test';
import assert from 'node:assert/strict';
import { canControl, canUseCommands, hasAnyRole, refusalMessage } from '../../controller/src/permissions.js';
import { validatePlayRequest } from '../../shared/src/ipc-protocol.js';

// A stand-in for a discord.js GuildMember: only roles.cache is used.
const memberWithRoles = (id, roles) => ({ id, roles: { cache: { has: (r) => roles.includes(r) } } });

test('hasAnyRole only matches ids the member actually holds', () => {
  const member = memberWithRoles('u1', ['role-a']);
  assert.equal(hasAnyRole(member, ['role-a']), true);
  assert.equal(hasAnyRole(member, ['role-b']), false);
  assert.equal(hasAnyRole(member, ['role-b', 'role-a']), true);
  assert.equal(hasAnyRole(member, []), false);
  assert.equal(hasAnyRole(null, ['role-a']), false);
});

test('the requester can always control their own stream', () => {
  const member = memberWithRoles('u1', []);
  assert.equal(canControl({ member, requesterId: 'u1', allowedRoleIds: [] }), true);
});

test('a stranger cannot control someone else stream', () => {
  const member = memberWithRoles('u2', []);
  assert.equal(canControl({ member, requesterId: 'u1', allowedRoleIds: [] }), false);
});

test('an allowed role grants control even without being the requester', () => {
  const member = memberWithRoles('u2', ['mod-role']);
  assert.equal(canControl({ member, requesterId: 'u1', allowedRoleIds: ['mod-role'] }), true);
  assert.equal(canControl({ member, requesterId: 'u1', allowedRoleIds: ['other'] }), false);
});

test('a missing member is refused rather than crashing', () => {
  assert.equal(canControl({ member: null, requesterId: 'u1', allowedRoleIds: ['x'] }), false);
  assert.equal(canControl({ member: undefined, requesterId: null, allowedRoleIds: [] }), false);
});

test('commands are open when no allow list is configured', () => {
  assert.equal(canUseCommands(memberWithRoles('u1', []), { allowedCommandRoleIds: [] }), true);
});

test('commands are restricted when an allow list is configured', () => {
  const config = { allowedCommandRoleIds: ['dj'] };
  assert.equal(canUseCommands(memberWithRoles('u1', ['dj']), config), true);
  assert.equal(canUseCommands(memberWithRoles('u2', []), config), false);
});

test('the refusal names the requester and mentions roles only when they exist', () => {
  const withRoles = refusalMessage({ requesterId: 'u1', allowedRoleIds: ['mod'] });
  assert.match(withRoles, /<@u1>/, 'the person who owns the stream should be named');
  assert.match(withRoles, /role allowed to control/, 'the role escape hatch should be mentioned');
  assert.doesNotMatch(withRoles, /\bcan can\b|\bcan\.\./, 'no duplicated words');

  const noRoles = refusalMessage({ requesterId: 'u1', allowedRoleIds: [] });
  assert.match(noRoles, /<@u1>/);
  assert.doesNotMatch(noRoles, /role allowed to control/, 'no roles configured, so do not mention them');
});

test('validatePlayRequest carries a resume point through', () => {
  const base = { malId: 21, episode: 4, audio: 'sub', captions: 'yes', guildId: '123456789012345678', channelId: '987654321098765432' };
  assert.equal(validatePlayRequest({ ...base, startAt: 600 }).value.startAt, 600);
  assert.equal(validatePlayRequest(base).value.startAt, 0, 'absent startAt means start from zero');
  assert.equal(validatePlayRequest({ ...base, startAt: -5 }).value.startAt, 0, 'negative is clamped');
  assert.equal(validatePlayRequest({ ...base, startAt: 'abc' }).value.startAt, 0, 'garbage is clamped');
  assert.equal(validatePlayRequest({ ...base, startAt: 90.7 }).value.startAt, 90, 'fractional is floored');
});

test('validatePlayRequest rejects every bad input with its own code', () => {
  const base = { episode: 1, audio: 'sub', captions: 'yes', guildId: '123456789012345678', channelId: '987654321098765432' };
  const cases = [
    [{ malId: 0 }, 'invalid_id'],
    [{ malId: -3 }, 'invalid_id'],
    [{ malId: 'abc' }, 'invalid_id'],
    [{ malId: 21, episode: 0 }, 'missing_episode'],
    [{ malId: 21, episode: undefined }, 'missing_episode'],
    [{ malId: 21, audio: 'french' }, 'bad_audio'],
    [{ malId: 21, captions: 'maybe' }, 'bad_captions'],
    [{ malId: 21, guildId: '123' }, 'no_voice'],
    [{ malId: 21, channelId: '' }, 'no_voice'],
  ];
  for (const [override, code] of cases) {
    const result = validatePlayRequest({ ...base, malId: 21, ...override });
    assert.equal(result.ok, false, `${JSON.stringify(override)} should be rejected`);
    assert.equal(result.code, code, `${JSON.stringify(override)} should report ${code}`);
  }
});
