import test from 'node:test';
import assert from 'node:assert/strict';
import { describePanel, describeMore, describeWatched, describeHistory, describeSeekModal, describeVolumeModal, describeStreamers, buildPanel, buildWatched, buildMore, buildSeekModal, languageLabel, accentFor, BTN, COLOR, EMOJI } from '../../shared/src/panel.js';
import { wire } from '../helpers/wire.js';

const BASE = {
  title: 'One Piece',
  episode: 1,
  searchUrl: 'https://www.google.com/search?q=One%20Piece%20episode%201',
  logoUrl: 'https://example.com/logo.png',
  position: 42,
  duration: 1440,
  audio: 'dub',
  captions: true,
  state: 'playing',
  error: null,
  volume: 1,
};

test('the main panel is a heading, bold lines, five emoji buttons and more', () => {
  const d = describePanel(BASE);
  assert.equal(d.accentColor, COLOR.playing);
  assert.equal(d.header, null);
  assert.equal(d.footer, null);
  assert.equal(d.children[0].kind, 'section');
  assert.equal(d.children[0].accessory.url, BASE.logoUrl);
  assert.equal(d.children[0].components[0].content, '## [One Piece - Episode 1](https://www.google.com/search?q=One%20Piece%20episode%201)');
  const text = d.children[1].content;
  assert.match(text, /^\*\*Type\*\* : `Series`/);
  assert.match(text, /\*\*Duration\*\* : `0:42\/24:00`/);
  assert.match(text, /\*\*Language\*\* : `Dub`/);
  assert.match(text, /\*\*Episode\*\* : `1\/\?`/);
  assert.match(text, /\*\*Autoplay\*\* : `Enabled`/);
  assert.match(text, /\*\*Captions\*\* : `Enabled`/);
  assert.doesNotMatch(text, /Status|Resumed/);
  assert.deepEqual(d.children[3].components.map((b) => b.id), [BTN.PREV_EP, BTN.BACK10, BTN.TOGGLE, BTN.FWD10, BTN.NEXT_EP]);
  assert.deepEqual(d.children[3].components.map((b) => b.emoji.id), [EMOJI.PREV.id, EMOJI.BACK.id, EMOJI.PAUSE.id, EMOJI.FWD.id, EMOJI.NEXT.id]);
  assert.equal(d.children[3].components.every((b) => !b.label), true);
  assert.equal(d.children[4].components[0].id, BTN.MORE);
  assert.equal(d.children[4].components[0].label, 'More options');
});

test('playing is blue, completed is green, and stopped is red', () => {
  assert.equal(accentFor('playing'), COLOR.playing);
  assert.equal(accentFor('paused'), COLOR.playing);
  assert.equal(accentFor('completed'), COLOR.completed);
  assert.equal(describePanel({ ...BASE, state: 'idle' }).accentColor, COLOR.stopped);
  assert.equal(describePanel({ ...BASE, state: 'error', error: 'no dub' }).accentColor, COLOR.stopped);
  assert.match(describePanel({ ...BASE, state: 'error', error: 'no dub' }).children[1].content, /\*\*Error\*\* : `no dub`/);
});

test('the real container carries the accent, the heading and the three buttons', async () => {
  const json = wire((await buildPanel(BASE)).toJSON());
  assert.equal(json.type, 17);
  assert.equal(json.accent_color, COLOR.playing);
  assert.equal(json.components[0].type, 9);
  assert.equal(json.components[0].accessory.type, 11);
  assert.equal(json.components[0].accessory.media.url, BASE.logoUrl);
  assert.equal(json.components[0].components[0].content.startsWith('## [One Piece'), true);
  const rows = json.components.filter((c) => c.type === 1);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].components.map((b) => b.emoji.id), [EMOJI.PREV.id, EMOJI.BACK.id, EMOJI.PAUSE.id, EMOJI.FWD.id, EMOJI.NEXT.id]);
  assert.equal(rows[1].components[0].label, 'More options');
  assert.equal(json.components.some((c) => /Status/.test(c.content || '')), false);
});

test('a missing logo still renders the heading', async () => {
  const json = wire((await buildPanel({ ...BASE, logoUrl: null })).toJSON());
  assert.equal(json.components[0].type, 10);
  assert.match(json.components[0].content, /^## \[One Piece - Episode 1\]/);
});

test('paused flips the center emoji to resume', () => {
  const row = describePanel({ ...BASE, state: 'paused' }).children[3];
  assert.equal(row.components[2].emoji.id, EMOJI.RESUME.id);
  assert.equal(row.components[0].emoji.id, EMOJI.PREV.id);
  assert.equal(row.components[4].emoji.id, EMOJI.NEXT.id);
});

test('a movie hides the episode line and disables episode buttons', () => {
  const d = describePanel({ ...BASE, format: 'MOVIE', title: 'Your Name' });
  assert.match(d.children[0].components[0].content, /^## \[Your Name\]/);
  assert.doesNotMatch(d.children[0].components[0].content, /Episode/);
  const text = d.children[1].content;
  assert.match(text, /\*\*Type\*\* : `Movie`/);
  assert.doesNotMatch(text, /\*\*Episode\*\*/);
  assert.equal(d.children[3].components[0].disabled, true);
  assert.equal(d.children[3].components[4].disabled, true);
});

test('more options is grouped sections with no volume sentence and no pipes', async () => {
  const d = describeMore({ ...BASE, volume: 3, autoplay: false, captions: true });
  assert.equal(d.children[0].content, '**Player**');
  assert.doesNotMatch(d.children.map((c) => c.content || c.components?.map((b) => b.label).join('')).join('\n'), /\|/);
  assert.deepEqual(d.children[1].components.map((b) => b.label), ['Seek', 'Skip intro', 'Skip outro', 'Skip recap']);
  assert.equal(d.children[2].content, '**Volume**');
  assert.deepEqual(d.children[3].components.map((b) => b.label), ['50%', '100%', '200%', '300%', 'Custom']);
  assert.equal(d.children[3].components[3].style, 'primary');
  assert.equal(d.children[4].content, '**Toggles**');
  assert.deepEqual(d.children[5].components.map((b) => b.label), ['Auto Play: Off', 'Captions: On']);
  assert.equal(d.children[6].content, '**Miscellaneous**');
  assert.equal(d.children[7].components[0].label, 'Stop');
  const json = wire((await buildMore({ ...BASE, volume: 2 })).toJSON());
  assert.equal(json.type, 17);
  assert.equal(json.components.filter((c) => c.type === 1).length, 4);
  for (const row of json.components.filter((c) => c.type === 1)) {
    assert.ok(row.components.length <= 5);
  }
});

test('language labels distinguish sub from dub', () => {
  assert.equal(languageLabel('dub'), 'Dub');
  assert.equal(languageLabel('sub'), 'Sub');
});

test('duration and language match the inline clock format', () => {
  const text = describePanel({ ...BASE, position: 367, duration: 1437, audio: 'sub', captions: false, autoplay: true, episode: 1, episodeCount: 1000 }).children[1].content;
  assert.match(text, /\*\*Type\*\* : `Series`\n\*\*Duration\*\* : `6:07\/23:57`/);
  assert.match(text, /\*\*Language\*\* : `Sub`/);
  assert.match(text, /\*\*Episode\*\* : `1\/1000`/);
  assert.match(text, /\*\*Autoplay\*\* : `Enabled`/);
  assert.match(text, /\*\*Captions\*\* : `Disabled`/);
  assert.doesNotMatch(text, /Resumed/);
});

test('a finished episode keeps the title and thumbnail, turns green, and disables the buttons', async () => {
  const d = describeWatched(BASE);
  assert.equal(d.accentColor, COLOR.completed);
  assert.equal(d.children[0].accessory.url, BASE.logoUrl);
  assert.match(d.children[0].components[0].content, /^## \[One Piece - Episode 1\]/);
  assert.doesNotMatch(d.children.map((c) => c.content || '').join('\n'), /Watched|Duration|Language|Captions/);
  const buttons = d.children.filter((c) => c.kind === 'row').flatMap((r) => r.components);
  assert.equal(buttons.length, 5);
  assert.ok(buttons.every((b) => b.disabled === true));
  const json = wire((await buildWatched(BASE)).toJSON());
  const wired = json.components.filter((c) => c.type === 1).flatMap((r) => r.components);
  assert.equal(wired.length, 5);
  assert.ok(wired.every((b) => b.disabled === true));
  assert.equal(json.accent_color, COLOR.completed);
  assert.equal(json.components.some((c) => /Watched|Duration|Language|Captions/.test(c.content || '')), false);
});

test('history is numbered, names only, and ends with a Discord timestamp', () => {
  const d = describeHistory([
    { title: 'One Piece', episode: 4, format: 'TV', updatedAt: Date.now() - 6 * 60 * 1000, malId: 21 },
    { title: 'Your Name', episode: 1, format: 'MOVIE', updatedAt: Date.now() - 8 * 60 * 1000, malId: 37987 },
  ]);
  const text = d.children.map((c) => c.content).join('\n');
  assert.match(text, /^## History\n1\. \*\*One Piece\*\* episode 4 at <t:\d+:R>\n2\. \*\*Your Name\*\* at <t:\d+:R>$/);
  assert.doesNotMatch(text, /MAL|21|37987/);
});

test('the streamer list shows state and lock, and nothing else', () => {
  const d = describeStreamers([
    { userId: '111', active: true, public: false, token: 'secret', channelId: '999' },
    { userId: '222', active: false, public: true },
  ]);
  const text = d.children.map((c) => c.content || '').join('\n');
  assert.match(text, /1\. <@111> - Active 🟢 🔒/);
  assert.match(text, /2\. <@222> - Inactive 🔴 🔓/);
  assert.doesNotMatch(text, /secret|999|token/);
  assert.deepEqual(d.children.at(-1).components.map((b) => b.label), ['Add', 'Manage']);
});

test('custom volume accepts up to 500 percent', () => {
  assert.equal(describeVolumeModal(5).components[0].components[0].placeholder, '1 to 500');
  assert.equal(describeVolumeModal(5).components[0].components[0].value, '500');
});

test('seek modal still accepts a prefilled position', async () => {
  assert.equal(describeSeekModal(42).customId, 'panel:seek:modal');
  const json = wire((await buildSeekModal(3723)).toJSON());
  assert.equal(json.custom_id, 'panel:seek:modal');
  assert.equal(json.components[0].components[0].value, '1:02:03');
});
