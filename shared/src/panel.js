import { formatDuration } from './time.js';

export const BTN = Object.freeze({
  PREV_EP: 'panel:prev-ep',
  BACK10: 'panel:back10',
  TOGGLE: 'panel:toggle',
  FWD10: 'panel:fwd10',
  NEXT_EP: 'panel:next-ep',
  MORE: 'panel:more',
  SEEK: 'panel:seek',
  SKIP_INTRO: 'panel:skip-intro',
  SKIP_OUTRO: 'panel:skip-outro',
  SKIP_RECAP: 'panel:skip-recap',
  VOL_50: 'panel:vol:50',
  VOL_100: 'panel:vol:100',
  VOL_200: 'panel:vol:200',
  VOL_300: 'panel:vol:300',
  VOL_CUSTOM: 'panel:vol:custom',
  AUTOPLAY: 'panel:autoplay',
  CAPTIONS: 'panel:captions',
  STOP: 'panel:stop',
  STREAMER_ADD: 'streamer:add',
  STREAMER_TOKEN: 'streamer:token',
  STREAMER_MANAGE: 'streamer:manage',
});

export const EMOJI = Object.freeze({
  PREV: { id: '1563549407587213363', name: 'back' },
  BACK: { id: '1563549367460171808', name: 'backward' },
  RESUME: { id: '1563550202600620123', name: 'resume' },
  PAUSE: { id: '1563550157021388971', name: 'pauseuu' },
  FWD: { id: '1563549711292571668', name: 'forward' },
  NEXT: { id: '1563549235289264173', name: 'Skip' },
});

export const COLOR = Object.freeze({
  playing: 0x5865f2,
  paused: 0x5865f2,
  completed: 0x23a559,
  stopped: 0xda373c,
});

export const VOLUME_MAX = 5;

export const VOLUME_LEVELS = Object.freeze([
  { id: BTN.VOL_50, level: 0.5, label: '50%' },
  { id: BTN.VOL_100, level: 1, label: '100%' },
  { id: BTN.VOL_200, level: 2, label: '200%' },
  { id: BTN.VOL_300, level: 3, label: '300%' },
]);

export function accentFor(state) {
  if (state === 'playing' || state === 'paused' || state === 'loading') return COLOR.playing;
  if (state === 'completed') return COLOR.completed;
  return COLOR.stopped;
}

export function isMovie(format) {
  return String(format || '').toUpperCase() === 'MOVIE';
}

export function typeLabel(format) {
  return isMovie(format) ? 'Movie' : 'Series';
}

export function languageLabel(audio) {
  return audio === 'dub' ? 'Dub' : 'Sub';
}

export function enabledLabel(on) {
  return on ? 'Enabled' : 'Disabled';
}

export function episodeLabel(episode, episodeCount) {
  const current = Number.isFinite(Number(episode)) ? String(episode) : '?';
  const total = Number.isFinite(Number(episodeCount)) && Number(episodeCount) > 0 ? String(episodeCount) : '?';
  return `${current}/${total}`;
}

function formatPanelClock(totalSeconds) {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function codeValue(value) {
  return `\`${String(value).replace(/`/g, '')}\``;
}

export function heading(title, episode, searchUrl, format) {
  const clean = String(title || 'Unknown').replace(/[\[\]]/g, '');
  const label = isMovie(format) ? clean : `${clean} - Episode ${episode}`;
  return `## [${label}](${searchUrl})`;
}

function infoLines(s) {
  const clock = `${formatPanelClock(s.position || 0)}/${formatPanelClock(s.duration || 0)}`;
  const lines = [
    `**Type** : ${codeValue(typeLabel(s.format))}`,
    `**Duration** : ${codeValue(clock)}`,
    `**Language** : ${codeValue(languageLabel(s.audio))}`,
  ];
  if (!isMovie(s.format)) lines.push(`**Episode** : ${codeValue(episodeLabel(s.episode, s.episodeCount))}`);
  lines.push(
    `**Autoplay** : ${codeValue(enabledLabel(s.autoplay !== false))}`,
    `**Captions** : ${codeValue(enabledLabel(!!s.captions))}`,
  );
  if (s.error) lines.push(`**Error** : ${codeValue(s.error)}`);
  return lines;
}

function transportButtons(s, disabled = false) {
  const paused = s.state === 'paused' || s.paused === true;
  const movie = isMovie(s.format);
  const atStart = Number(s.episode) <= 1;
  const atEnd = Number(s.episodeCount) > 0 && Number(s.episode) >= Number(s.episodeCount);
  return [
    { kind: 'button', id: BTN.PREV_EP, emoji: EMOJI.PREV, style: 'secondary', disabled: disabled || movie || atStart },
    { kind: 'button', id: BTN.BACK10, emoji: EMOJI.BACK, style: 'secondary', disabled },
    { kind: 'button', id: BTN.TOGGLE, emoji: paused ? EMOJI.RESUME : EMOJI.PAUSE, style: 'primary', disabled },
    { kind: 'button', id: BTN.FWD10, emoji: EMOJI.FWD, style: 'secondary', disabled },
    { kind: 'button', id: BTN.NEXT_EP, emoji: EMOJI.NEXT, style: 'secondary', disabled: disabled || movie || atEnd },
  ];
}

export function describePanel(s) {
  const children = [];
  const title = { kind: 'text', content: heading(s.title, s.episode, s.searchUrl, s.format) };
  if (s.logoUrl) {
    children.push({
      kind: 'section',
      accessory: { kind: 'thumbnail', url: s.logoUrl },
      components: [title],
    });
  } else {
    children.push(title);
  }
  children.push(
    { kind: 'text', content: infoLines(s).join('\n') },
    { kind: 'separator', spacing: 'small', divider: true },
    { kind: 'row', components: transportButtons(s) },
    {
      kind: 'row',
      components: [{ kind: 'button', id: BTN.MORE, label: 'More options', style: 'secondary' }],
    },
  );
  return {
    kind: 'container',
    accentColor: accentFor(s.state),
    header: null,
    footer: null,
    children,
  };
}

export function describeWatched(s) {
  const title = { kind: 'text', content: heading(s.title, s.episode, s.searchUrl, s.format) };
  const children = [];
  if (s.logoUrl) {
    children.push({
      kind: 'section',
      accessory: { kind: 'thumbnail', url: s.logoUrl },
      components: [title],
    });
  } else {
    children.push(title);
  }
  children.push(
    { kind: 'separator', spacing: 'small', divider: true },
    { kind: 'row', components: transportButtons(s, true) },
  );
  return {
    kind: 'container',
    accentColor: COLOR.completed,
    header: null,
    footer: null,
    children,
  };
}

export function describeMore(s) {
  const volume = Number.isFinite(s.volume) ? s.volume : 1;
  const preset = VOLUME_LEVELS.some((v) => Math.abs(volume - v.level) < 0.01);
  const children = [
    { kind: 'text', content: '**Player**' },
    {
      kind: 'row',
      components: [
        { kind: 'button', id: BTN.SEEK, label: 'Seek', style: 'secondary' },
        { kind: 'button', id: BTN.SKIP_INTRO, label: 'Skip intro', style: 'secondary' },
        { kind: 'button', id: BTN.SKIP_OUTRO, label: 'Skip outro', style: 'secondary' },
        { kind: 'button', id: BTN.SKIP_RECAP, label: 'Skip recap', style: 'secondary' },
      ],
    },
    { kind: 'text', content: '**Volume**' },
    {
      kind: 'row',
      components: [
        ...VOLUME_LEVELS.map((v) => ({
          kind: 'button',
          id: v.id,
          label: v.label,
          style: Math.abs(volume - v.level) < 0.01 ? 'primary' : 'secondary',
        })),
        { kind: 'button', id: BTN.VOL_CUSTOM, label: 'Custom', style: preset ? 'secondary' : 'primary' },
      ],
    },
    { kind: 'text', content: '**Toggles**' },
    {
      kind: 'row',
      components: [
        {
          kind: 'button',
          id: BTN.AUTOPLAY,
          label: s.autoplay !== false ? 'Auto Play: On' : 'Auto Play: Off',
          style: s.autoplay !== false ? 'primary' : 'secondary',
        },
        {
          kind: 'button',
          id: BTN.CAPTIONS,
          label: s.captions ? 'Captions: On' : 'Captions: Off',
          style: s.captions ? 'primary' : 'secondary',
        },
      ],
    },
    { kind: 'text', content: '**Miscellaneous**' },
    {
      kind: 'row',
      components: [{ kind: 'button', id: BTN.STOP, label: 'Stop', style: 'danger' }],
    },
  ];
  if (s.note) children.push({ kind: 'text', content: String(s.note) });
  return {
    kind: 'container',
    accentColor: accentFor(s.state),
    header: null,
    footer: null,
    children,
  };
}

export function describeHistory(rows) {
  const lines = (rows || []).map((row, index) => {
    const name = String(row.title || 'Saved series').replace(/[`[\]]/g, '');
    const episode = isMovie(row.format) ? '' : ` episode ${row.episode}`;
    const unix = Math.floor(Number(row.updatedAt) / 1000);
    const when = Number.isFinite(unix) && unix > 0 ? ` at <t:${unix}:R>` : '';
    return `${index + 1}. **${name}**${episode}${when}`;
  });
  return {
    kind: 'container',
    accentColor: COLOR.playing,
    header: null,
    footer: null,
    children: [
      { kind: 'text', content: '## History' },
      { kind: 'text', content: lines.length ? lines.join('\n') : 'Nothing recorded yet. Start one with /stream.' },
    ],
  };
}

export function describeHelp(botName = 'Jinx') {
  return {
    kind: 'container',
    accentColor: COLOR.playing,
    header: null,
    footer: null,
    children: [
      { kind: 'text', content: `## ${botName}` },
      {
        kind: 'text',
        content: [
          `**Stream** : \`/stream anime:name episode:1 audio:sub\``,
          'Episode is optional. It starts at the last watched episode, or episode 1.',
          'A movie hides the episode line and starts at episode 1.',
          `**Continue** : \`/continue anime:name\``,
          `**History** : \`/history\``,
          `**Stop** : \`/stop\``,
          `**Streamer** : \`/streamer\``,
          `**Ping** : \`/ping\``,
        ].join('\n'),
      },
      { kind: 'separator', spacing: 'small', divider: true },
      {
        kind: 'text',
        content: 'The main row is previous episode, back 10 seconds, pause or resume, forward 10 seconds, and next episode. More options has seek, skips, volume to 500%, captions, autoplay and stop.',
      },
    ],
  };
}

export function describePing({ gateway, roundtrip }) {
  return {
    kind: 'container',
    accentColor: COLOR.playing,
    header: null,
    footer: null,
    children: [
      { kind: 'text', content: '## Ping' },
      { kind: 'text', content: `**Gateway** : ${codeValue(`${gateway}ms`)}\n**Round trip** : ${codeValue(`${roundtrip}ms`)}` },
    ],
  };
}

export function describeStreamers(rows) {
  const lines = (rows || []).map((row, index) => {
    const who = row.userId ? `<@${row.userId}>` : row.label || 'Streamer';
    const state = row.active ? 'Active 🟢' : 'Inactive 🔴';
    const lock = row.public ? '🔓' : '🔒';
    return `${index + 1}. ${who} - ${state} ${lock}`;
  });
  return {
    kind: 'container',
    accentColor: COLOR.playing,
    header: null,
    footer: null,
    children: [
      { kind: 'text', content: '## Streamers' },
      { kind: 'text', content: lines.length ? lines.join('\n') : 'No streamers yet.' },
      { kind: 'separator', spacing: 'small', divider: true },
      {
        kind: 'row',
        components: [
          { kind: 'button', id: BTN.STREAMER_ADD, label: 'Add', style: 'primary' },
          { kind: 'button', id: BTN.STREAMER_MANAGE, label: 'Manage', style: 'secondary' },
        ],
      },
    ],
  };
}

export function describeManage(rows) {
  const priv = (rows || []).filter((row) => !row.public);
  const children = [
    { kind: 'text', content: '## Manage' },
    {
      kind: 'text',
      content: priv.length
        ? 'Remove a private streamer. Public streamers stay in .env.'
        : 'No private streamers. Public streamers are set in .env.',
    },
  ];
  for (let i = 0; i < priv.length; i += 5) {
    children.push({
      kind: 'row',
      components: priv.slice(i, i + 5).map((row) => ({
        kind: 'button',
        id: `streamer:remove:${row.id}`,
        label: `Remove ${row.label || 'streamer'}`.slice(0, 80),
        style: 'danger',
      })),
    });
  }
  return {
    kind: 'container',
    accentColor: COLOR.playing,
    header: null,
    footer: null,
    children,
  };
}

export const SEEK_MODAL_ID = 'panel:seek:modal';
export const VOLUME_MODAL_ID = 'panel:volume:modal';
export const STREAMER_MODAL_ID = 'streamer:add:modal';
export const STREAMER_CHANNEL_ID = 'streamer:channel';

export function describeVolumeModal(volume) {
  const percent = Math.round((Number.isFinite(volume) ? volume : 1) * 100);
  return {
    kind: 'modal',
    customId: VOLUME_MODAL_ID,
    title: 'Custom volume',
    components: [
      {
        kind: 'row',
        components: [
          {
            kind: 'text-input',
            customId: 'volume_value',
            style: 'short',
            label: 'Percent',
            placeholder: '1 to 500',
            required: true,
            value: String(Math.min(500, Math.max(1, percent))),
          },
        ],
      },
    ],
  };
}

export function describeSeekModal(currentPosition) {
  return {
    kind: 'modal',
    customId: SEEK_MODAL_ID,
    title: 'Seek to',
    components: [
      {
        kind: 'row',
        components: [
          {
            kind: 'text-input',
            customId: 'seek_value',
            style: 'short',
            label: 'Position',
            placeholder: '90, 1:30 or 01:02:03',
            required: true,
            value: formatDuration(currentPosition || 0),
          },
        ],
      },
    ],
  };
}

export function buildContainer(d, builders) {
  const {
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ThumbnailBuilder,
    SeparatorSpacingSize,
  } = builders;

  const STYLE = {
    primary: ButtonStyle.Primary,
    secondary: ButtonStyle.Secondary,
    danger: ButtonStyle.Danger,
  };

  const container = new ContainerBuilder();
  if (d.accentColor != null) container.setAccentColor(d.accentColor);

  for (const child of d.children) {
    if (child.kind === 'section') {
      const text = child.components.map((c) => c.content).join('\n');
      if (!child.accessory?.url) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
        continue;
      }
      const section = new SectionBuilder();
      section.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
      section.setThumbnailAccessory(new ThumbnailBuilder().setURL(child.accessory.url));
      container.addSectionComponents(section);
    } else if (child.kind === 'text') {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(child.content));
    } else if (child.kind === 'separator') {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(child.divider !== false),
      );
    } else if (child.kind === 'row') {
      const row = new ActionRowBuilder();
      for (const b of child.components) {
        const button = new ButtonBuilder()
          .setCustomId(b.id)
          .setStyle(STYLE[b.style] ?? ButtonStyle.Secondary);
        if (b.emoji) button.setEmoji(b.emoji);
        if (b.label) button.setLabel(b.label);
        if (b.disabled) button.setDisabled(true);
        row.addComponents(button);
      }
      container.addActionRowComponents(row);
    }
  }
  return container;
}

export async function buildPanel(state) {
  const builders = await import('discord.js');
  return buildContainer(describePanel(state), builders);
}

export async function buildWatched(state) {
  const builders = await import('discord.js');
  return buildContainer(describeWatched(state), builders);
}

export async function buildMore(state) {
  const builders = await import('discord.js');
  return buildContainer(describeMore(state), builders);
}

export async function buildHistory(rows) {
  const builders = await import('discord.js');
  return buildContainer(describeHistory(rows), builders);
}

export async function buildVolumeModal(volume) {
  const { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } = await import('discord.js');
  const d = describeVolumeModal(volume);
  const input = d.components[0].components[0];
  const modal = new ModalBuilder().setCustomId(d.customId).setTitle(d.title);
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(input.customId)
        .setLabel(input.label)
        .setPlaceholder(input.placeholder)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(input.value),
    ),
  );
  return modal;
}

export async function buildSeekModal(currentPosition) {
  const { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } = await import('discord.js');
  const d = describeSeekModal(currentPosition);
  const input = d.components[0].components[0];
  const modal = new ModalBuilder().setCustomId(d.customId).setTitle(d.title);
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(input.customId)
        .setLabel(input.label)
        .setPlaceholder(input.placeholder)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(input.value),
    ),
  );
  return modal;
}
