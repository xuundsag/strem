// JINX: the controller half.
//
// This is a normal bot. It logs in with a bot token, owns the slash commands and
// the control panel, and tells the streamer what to do over localhost. It never
// touches video, never runs a browser, and never uses a user token.
//
// Why the split exists: Discord does not let bot accounts send video, so the Go
// Live half has to be a separate selfbot process. That half has no commands and
// no interface, which means everything a person interacts with lives here.

import 'dotenv/config';
import * as discord from 'discord.js';
import { IpcClient } from '../../streamer/src/ipc-client.js';
import { loadConfig, assertConfig } from './config.js';
import { registerCommands } from './slash-commands.js';
import { panelMessage, moreOptionsMessage, watchedMessage, historyMessage, helpMessage, pingMessage, streamerMessage, manageMessage, PANEL_MESSAGE_FLAGS } from './panel-message.js';
import { autoplayPlan } from './autoplay.js';
import { PanelRefresher } from './panel-refresher.js';
import { canUseCommands, canControl, canManageStreamers, refusalMessage } from './permissions.js';
import { ProgressStore } from '../../shared/src/progress.js';
import { StreamerStore, chooseAccount, parsePublicStreamers } from '../../shared/src/streamers.js';
import { setVoiceStatus, voiceStatusText } from './voice-status.js';
import { parseTimeInput, formatDuration, clampSeek } from '../../shared/src/time.js';
import { googleSearchUrl } from '../../shared/src/urls.js';
import { lookup as lookupMetadata } from '../../shared/src/metadata.js';
import { resolveAnimeName } from '../../shared/src/search.js';
import { BTN, SEEK_MODAL_ID, VOLUME_MODAL_ID, VOLUME_MAX, STREAMER_MODAL_ID, STREAMER_CHANNEL_ID, isMovie } from '../../shared/src/panel.js';

const { Client, GatewayIntentBits, MessageFlags, InteractionType, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, ChannelSelectMenuBuilder, ChannelType, ButtonBuilder, ButtonStyle } = discord;

const config = loadConfig();
const log = (...args) => console.log(`[${config.botName}]`, ...args);

const ipc = new IpcClient({ baseUrl: config.ipcBaseUrl, token: config.ipcToken });
const progress = new ProgressStore(config.progressFile, log);
const streamerStore = new StreamerStore(config.streamerFile);
const pendingChannels = new Map();
const panels = new PanelRefresher({ intervalMs: config.panelRefreshMs, flags: PANEL_MESSAGE_FLAGS, log });

/**
 * One entry per guild that has a stream.
 * @type {Map<string, object>}
 */
const sessions = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

async function main() {
  assertConfig(config);

  // Confirm the streamer answers before registering commands. A bot that
  // replies "streamer offline" to every /play is worse than one that fails at
  // boot and says why.
  await waitForStreamer();

  await client.login(config.botToken);
  log(`logged in as ${client.user.tag}`);

  await registerCommands({ token: config.botToken, clientId: config.clientId, guildId: config.guildId, log });

  setInterval(() => poll().catch((e) => log(`poll failed: ${e.message}`)), 1000).unref?.();
  setInterval(saveAllProgress, config.progressSaveIntervalMs).unref?.();

  const shutdown = async (reason) => {
    log(`${reason}, shutting down`);
    for (const session of sessions.values()) saveProgress(session);
    panels.stop();
    try {
      await ipc.stop();
    } catch {
      /* the streamer may already be gone */
    }
    client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** Wait for the streamer, so `node run.js` can start both at the same time. */
async function waitForStreamer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    try {
      await ipc.health();
      log(`streamer reachable at ${config.ipcBaseUrl}`);
      return;
    } catch {
      attempts++;
      if (attempts === 1) log(`waiting for the streamer at ${config.ipcBaseUrl}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`The streamer did not answer at ${config.ipcBaseUrl}. Start it with: node run.js streamer`);
}

/**
 * Read the streamer once per tick.
 *
 * Doing this on a timer rather than on a push channel keeps the two processes
 * simple: the streamer only answers questions, and the controller decides when
 * the panel is worth redrawing.
 */
async function poll() {
  for (const [guildId, session] of sessions) {
    if (session.transitioning || session.userStop) continue;
    let status;
    try {
      const res = await ipc.status();
      status = res.status;
    } catch (err) {
      status = {
        state: 'error',
        error: `streamer unreachable: ${err.message}`,
        position: session.lastStatus?.position || 0,
        duration: session.lastStatus?.duration || 0,
        ended: false,
      };
    }

    const previous = session.lastStatus?.state;
    session.lastStatus = status;

    if (previous && previous !== 'idle' && status.state === 'idle' && status.ended) {
      session.transitioning = true;
      panels.dropTarget(guildId);
      await onEpisodeEnded(session, status);
      continue;
    }

    saveProgress(session);
    panels.update(guildId, panelState(session, status));
  }
}

async function onEpisodeEnded(session, status) {
  markFinished(session, status);
  log(`episode ${session.episode} finished`);
  await editWatched(session);

  try {
    await ipc.stop();
  } catch (err) {
    log(`stop after episode end failed: ${err.message}`);
  }

  if (session.userStop) {
    sessions.delete(session.guildId);
    return;
  }

  const plan = autoplayPlan(session);
  if (plan.action !== 'advance') {
    if (plan.reason) log(`autoplay stopped: ${session.title} ${plan.reason}`);
    await clearVoiceStatus(session.channelId);
    sessions.delete(session.guildId);
    return;
  }

  log(`autoplay: stream ended, starting episode ${plan.episode}`);
  let res;
  try {
    res = await playNext({
      malId: session.malId,
      episode: plan.episode,
      audio: session.audio,
      captions: session.captions,
      guildId: session.guildId,
      channelId: session.channelId,
      requesterId: session.requesterId,
      title: session.title,
      startAt: 0,
    });
  } catch (err) {
    log(`autoplay could not start episode ${plan.episode}: ${err.message}`);
    sessions.delete(session.guildId);
    const channel = await textChannel(session).catch(() => null);
    if (channel) {
      await channel.send({ content: `Autoplay stopped on episode ${plan.episode}: ${err.message}` }).catch(() => {});
    }
    return;
  }

  session.episode = plan.episode;
  session.resumeFrom = 0;
  session.transitioning = false;
  session.lastStatus = res.status;
  if (session.volume && session.volume !== 1) {
    await ipc.volume(session.volume).catch((err) => log(`volume restore failed: ${err.message}`));
  }
  try {
    const channel = await textChannel(session);
    const message = await channel.send(panelSend(session, res.status));
    session.message = message;
    panels.setTarget(session.guildId, message);
  } catch (err) {
    log(`could not post the next panel: ${err.message}`);
  }
}

async function playNext(body) {
  try {
    return await ipc.play(body);
  } catch (err) {
    if (err.status !== 409) throw err;
    await ipc.stop().catch(() => {});
    return ipc.play(body);
  }
}

async function editWatched(session) {
  if (!session.message) return;
  const payload = watchedMessage(panelState(session, { ...session.lastStatus, state: 'idle' }), discord);
  await session.message.edit({ components: payload.components, flags: payload.flags }).catch((err) => {
    log(`could not mark the old panel watched: ${err.message}`);
  });
}

function panelSend(session, status) {
  const payload = panelPayload(session, status);
  return { components: payload.components, flags: payload.flags };
}

async function textChannel(session) {
  if (session.message?.channel) return session.message.channel;
  if (!session.textChannelId) throw new Error('No channel to post the next panel in.');
  return client.channels.fetch(session.textChannelId);
}

function markFinished(session, status) {
  const duration = Math.max(0, Math.floor(status?.duration || status?.position || 0));
  const position = duration > 0 ? duration : Math.max(1, Math.floor(status?.position || 1));
  progress.set({
    userId: session.requesterId,
    malId: session.malId,
    episode: session.episode,
    position,
    duration: duration || position,
    audio: session.audio,
    captions: session.captions,
    title: session.title,
    format: session.format,
  });
}

/** Assemble everything the panel needs from a session plus the latest status. */
function panelState(session, status) {
  const st = status || {};
  return {
    title: session.title,
    episode: session.episode,
    searchUrl: googleSearchUrl(session.title, isMovie(session.format) ? null : session.episode),
    logoUrl: session.logoUrl,
    position: st.position || 0,
    duration: st.duration || 0,
    audio: session.audio,
    captions: session.captions,
    state: st.state || 'loading',
    error: st.error || null,
    autoplay: session.autoplay,
    episodeCount: session.episodeCount,
    format: session.format,
    volume: session.volume ?? 1,
  };
}

function panelPayload(session, status) {
  return panelMessage(panelState(session, status), discord);
}

function morePayload(session, status, note) {
  return moreOptionsMessage({ ...panelState(session, status), note: note || null }, discord);
}

function saveProgress(session) {
  const st = session.lastStatus;
  if (!st || !st.position) return;
  progress.set({
    userId: session.requesterId,
    malId: session.malId,
    episode: session.episode,
    position: st.position,
    duration: st.duration,
    audio: session.audio,
    captions: session.captions,
    title: session.title,
    format: session.format,
  });
}

function saveAllProgress() {
  for (const session of sessions.values()) saveProgress(session);
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
    if (interaction.type === InteractionType.MessageComponent) return await handleButton(interaction);
    if (interaction.type === InteractionType.ModalSubmit) return await handleModal(interaction);
  } catch (err) {
    log(`interaction failed: ${err.message}`);
    const body = { content: `That did not work: ${err.message}`, flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(body);
      else await interaction.reply(body);
    } catch {
      /* the interaction window already closed */
    }
  }
});

async function handleCommand(interaction) {
  if (!canUseCommands(interaction.member, config)) {
    return interaction.reply({
      content: 'You do not have a role that is allowed to start streams here.',
      flags: MessageFlags.Ephemeral,
    });
  }
  switch (interaction.commandName) {
    case 'stream':
      return streamCommand(interaction);
    case 'continue':
      return continueCommand(interaction);
    case 'stop':
      return stopCommand(interaction);
    case 'history':
      return historyCommand(interaction);
    case 'streamer':
      return streamerCommand(interaction);
    case 'help':
      return helpCommand(interaction);
    case 'ping':
      return pingCommand(interaction);
    default:
      return interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
  }
}

async function handleAutocomplete(interaction) {
  if (interaction.commandName !== 'continue') return interaction.respond([]);
  const focused = interaction.options.getFocused().toLowerCase();
  const names = progress.namesForUser(interaction.user.id);
  const choices = names
    .filter((name) => !focused || name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((name) => ({ name: name.slice(0, 100), value: name.slice(0, 100) }));
  return interaction.respond(choices);
}

/**
 * Validate the options, then hand off to startPlayback.
 * Validation happens before deferring so a bad id fails instantly instead of
 * after a visible "thinking" pause.
 */
async function streamCommand(interaction) {
  const anime = interaction.options.getString('anime', true).trim();
  const requested = interaction.options.getNumber('episode');
  const audio = interaction.options.getString('audio', true);

  const problems = [];
  if (anime.length < 2) problems.push('Type at least 2 letters of the anime name.');
  if (requested != null && (!(requested > 0) || requested > 100000)) problems.push('episode must be a number greater than 0.');
  if (problems.length) {
    return interaction.reply({ content: problems.join('\n'), flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: PANEL_MESSAGE_FLAGS });
  await interaction.editReply({ content: `Looking up ${anime}...` });
  let resolved;
  try {
    resolved = await resolveAnimeName(anime, { log });
  } catch (err) {
    return interaction.editReply({ content: err.message });
  }
  const movie = isMovie(resolved.format);
  const saved = progress.latestForMal(interaction.user.id, resolved.malId);
  const episode = movie ? 1 : requested || saved?.episode || 1;
  const resumeFrom = progress.resumeAt(interaction.user.id, resolved.malId, episode);
  return startPlayback(interaction, {
    malId: resolved.malId,
    episode,
    audio,
    captions: true,
    resumeFrom,
    title: resolved.title,
    logoUrl: resolved.logoUrl,
    episodeCount: movie ? 1 : resolved.episodeCount,
    format: resolved.format,
  });
}

async function continueCommand(interaction) {
  const name = interaction.options.getString('anime', true).trim();
  const row = progress.latestForTitle(interaction.user.id, name);
  if (!row) {
    return interaction.reply({
      content: 'That series is not in your saved list. Start it with /stream first.',
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferReply({ flags: PANEL_MESSAGE_FLAGS });
  const meta = await lookupMetadata({ malId: row.malId, tmdbKey: config.tmdbKey, fanartKey: config.fanartKey, log }).catch((err) => {
    log(`metadata lookup failed: ${err.message}`);
    return null;
  });
  const title = meta?.title && !/^MAL \d+$/.test(meta.title) ? meta.title : row.title;
  if (!title) {
    return interaction.editReply({ content: 'That saved series did not resolve to a title. Start it again with /stream.' });
  }
  return startPlayback(interaction, {
    malId: row.malId,
    episode: isMovie(row.format) ? 1 : row.episode,
    audio: row.audio || 'sub',
    captions: true,
    resumeFrom: row.finished ? 0 : row.position,
    title,
    logoUrl: meta?.logoUrl || null,
    episodeCount: isMovie(row.format) ? 1 : meta?.episodeCount ?? null,
    format: row.format,
  });
}

/**
 * Look up the series, ask the streamer to start, and post the panel.
 * Shared by /play and /resume.
 */
async function startPlayback(interaction, { malId, episode, audio, captions = true, resumeFrom = 0, title, logoUrl, episodeCount, format }) {
  const target = await resolveVoiceTarget(interaction);
  if (target.error) return interaction.editReply({ content: target.error });
  if (sessions.has(interaction.guildId)) {
    const existing = sessions.get(interaction.guildId);
    return interaction.editReply({
      content: `A stream is already running here (episode ${existing.episode}). Press Stop or use /stop first.`,
    });
  }

  const knownTitle = title && !/^MAL \d+$/.test(title) ? title : null;
  if (!knownTitle) {
    return interaction.editReply({ content: 'Playback did not start because the series title could not be confirmed.' });
  }
  const meta = { title: knownTitle, logoUrl: logoUrl || null, episodeCount: episodeCount ?? null };

  const session = {
    guildId: interaction.guildId,
    channelId: target.channelId,
    format: format || null,
    textChannelId: interaction.channelId,
    requesterId: interaction.user.id,
    malId,
    episode,
    audio,
    captions,
    autoplay: config.autoplayDefault,
    title: meta.title,
    logoUrl: meta.logoUrl,
    episodeCount: meta.episodeCount ?? null,
    resumeFrom,
    volume: 1,
    message: null,
    lastStatus: null,
  };

  let res;
  try {
    res = await ipc.play({
      malId,
      episode,
      audio,
      captions,
      guildId: interaction.guildId,
      channelId: target.channelId,
      requesterId: interaction.user.id,
      title: meta.title,
      startAt: resumeFrom,
    });
  } catch (err) {
    sessions.delete(interaction.guildId);
    return interaction.editReply({ content: describeIpcFailure(err, { malId, episode }) });
  }

  session.lastStatus = res.status;
  if (res.channelId) session.channelId = res.channelId;
  sessions.set(interaction.guildId, session);
  await applyVoiceStatus(session);

  const message = await interaction.editReply(panelPayload(session, res.status));
  session.message = message;
  panels.setTarget(interaction.guildId, message);

  if (resumeFrom > 0) log(`continuing episode ${episode} from ${formatDuration(resumeFrom)}`);
  return message;
}

async function stopCommand(interaction) {
  const session = sessions.get(interaction.guildId);
  if (!session) {
    return interaction.reply({ content: 'Nothing is streaming here.', flags: MessageFlags.Ephemeral });
  }
  if (!canControl({ member: interaction.member, requesterId: session.requesterId, allowedRoleIds: config.allowedRoleIds })) {
    return interaction.reply({
      content: refusalMessage({ requesterId: session.requesterId, allowedRoleIds: config.allowedRoleIds }),
      flags: MessageFlags.Ephemeral,
    });
  }
  await teardown(interaction.guildId);
  return interaction.reply({ content: 'Stopped and left the voice channel.', flags: MessageFlags.Ephemeral });
}

async function historyCommand(interaction) {
  const limit = Math.min(10, Math.max(1, interaction.options.getInteger('limit') || 5));
  const rows = progress.forUser(interaction.user.id).slice(0, limit).map((row) => ({
    title: row.title,
    episode: row.episode,
    format: row.format,
    updatedAt: row.updatedAt,
    finished: row.finished,
  }));
  const payload = historyMessage(rows, discord);
  return interaction.reply({ components: payload.components, flags: payload.flags });
}

async function helpCommand(interaction) {
  const payload = helpMessage(config.botName, discord);
  return interaction.reply({ components: payload.components, flags: payload.flags });
}

async function pingCommand(interaction) {
  const sent = Date.now();
  await interaction.deferReply({ flags: PANEL_MESSAGE_FLAGS });
  const payload = pingMessage({ gateway: Math.round(interaction.client.ws.ping), roundtrip: Date.now() - sent }, discord);
  return interaction.editReply({ components: payload.components, flags: payload.flags });
}

async function streamerCommand(interaction) {
  const rows = await roster();
  const payload = streamerMessage(rows, discord);
  return interaction.reply({ components: payload.components, flags: payload.flags });
}

async function roster() {
  try {
    const res = await ipc.streamers();
    return res.streamers || [];
  } catch (err) {
    log(`streamer list failed: ${err.message}`);
    return [];
  }
}

async function resolveVoiceTarget(interaction) {
  const sitting = interaction.member?.voice?.channel?.id || null;
  const rows = await roster();
  const choice = chooseAccount(rows, { channelId: sitting });
  if (!choice) {
    return { error: 'No streamer is free. Add one with /streamer, or set PUBLIC_STREAMERS in .env.' };
  }
  if (choice.channelId) return { channelId: choice.channelId };
  try {
    const picked = await ipc.pickChannel(interaction.guildId);
    if (!picked.channelId) return { error: 'No voice channel was available.' };
    return { channelId: picked.channelId };
  } catch (err) {
    return { error: err.message };
  }
}

async function applyVoiceStatus(session) {
  try {
    await setVoiceStatus(client.rest, session.channelId, voiceStatusText(session));
  } catch (err) {
    log(`voice status was not set: ${err.message}`);
  }
}

async function clearVoiceStatus(channelId) {
  try {
    await setVoiceStatus(client.rest, channelId, '');
  } catch (err) {
    log(`voice status was not cleared: ${err.message}`);
  }
}

async function handleButton(interaction) {
  const id = interaction.customId;
  if (
    id === BTN.STREAMER_ADD ||
    id === BTN.STREAMER_TOKEN ||
    id === BTN.STREAMER_MANAGE ||
    id === STREAMER_CHANNEL_ID ||
    id.startsWith('streamer:remove:')
  ) {
    return handleStreamerButton(interaction);
  }
  const session = sessions.get(interaction.guildId);
  if (!session) {
    return interaction.reply({ content: 'That panel belongs to a stream that has already ended.', flags: MessageFlags.Ephemeral });
  }
  if (!canControl({ member: interaction.member, requesterId: session.requesterId, allowedRoleIds: config.allowedRoleIds })) {
    return interaction.reply({
      content: refusalMessage({ requesterId: session.requesterId, allowedRoleIds: config.allowedRoleIds }),
      flags: MessageFlags.Ephemeral,
    });
  }

  const status = session.lastStatus || {};

  if (id === BTN.SEEK) {
    return interaction.showModal(buildSeekModal(status.position || 0));
  }
  if (id === BTN.VOL_CUSTOM) {
    return interaction.showModal(buildVolumeModal(session.volume ?? 1));
  }
  if (id === BTN.MORE) {
    return interaction.reply(morePayload(session, status));
  }

  await interaction.deferUpdate();
  const onMain = id === BTN.BACK10 || id === BTN.FWD10 || id === BTN.TOGGLE || id === BTN.PREV_EP || id === BTN.NEXT_EP;

  try {
    if (id === BTN.PREV_EP) return changeEpisode(session, interaction, -1);
    if (id === BTN.NEXT_EP) return changeEpisode(session, interaction, 1);
    if (id === BTN.BACK10) return applySeek(session, Math.max(0, (status.position || 0) - 10), interaction);
    if (id === BTN.FWD10) return applySeek(session, (status.position || 0) + 10, interaction);
    if (id === BTN.TOGGLE) return togglePlayPause(session, status, interaction);
    if (id === BTN.SKIP_INTRO) return runMarkedSkip(session, interaction, 'intro');
    if (id === BTN.SKIP_OUTRO) return runMarkedSkip(session, interaction, 'outro');
    if (id === BTN.SKIP_RECAP) return runMarkedSkip(session, interaction, 'recap');
    if (id === BTN.AUTOPLAY) {
      session.autoplay = !session.autoplay;
      log(`autoplay ${session.autoplay ? 'on' : 'off'} for ${session.title}`);
      return refreshClicked(session, interaction, onMain);
    }
    if (id === BTN.CAPTIONS) {
      session.captions = !session.captions;
      const res = await ipc.setCaptions(session.captions);
      if (res?.status) session.lastStatus = res.status;
      return refreshClicked(session, interaction, onMain);
    }
    if (id === BTN.STOP) {
      const stopped = panelState(session, { ...status, state: 'idle' });
      await teardown(interaction.guildId);
      return interaction.editReply(moreOptionsMessage({ ...stopped, state: 'idle', note: 'Stopped.' }, discord));
    }
    const level = VOLUME_LEVELS.find((v) => v.id === id);
    if (level) {
      session.volume = level.level;
      await ipc.volume(level.level);
      return refreshClicked(session, interaction, false);
    }
    return refreshClicked(session, interaction, onMain);
  } catch (err) {
    log(`button ${id} failed: ${err.message}`);
    if (onMain) return interaction.editReply(panelPayload(session, { ...session.lastStatus, error: err.message }));
    return interaction.editReply(morePayload(session, session.lastStatus, err.message));
  }
}

async function refreshClicked(session, interaction, onMain, note) {
  panels.update(session.guildId, panelState(session, session.lastStatus));
  if (onMain) return interaction.editReply(panelPayload(session, session.lastStatus));
  if (session.message) await session.message.edit(panelPayload(session, session.lastStatus)).catch(() => {});
  return interaction.editReply(morePayload(session, session.lastStatus, note));
}

async function runMarkedSkip(session, interaction, which) {
  const res = which === 'intro' ? await ipc.skipIntro() : which === 'outro' ? await ipc.skipOutro() : await ipc.skipRecap();
  session.lastStatus = res.status;
  log(res.reason || which);
  return refreshClicked(session, interaction, false, res.reason);
}

async function applySeek(session, seconds, interaction) {
  const duration = session.lastStatus?.duration || 0;
  const check = clampSeek(seconds, duration);
  if (!check.ok) {
    return interaction.editReply(panelPayload(session, { ...session.lastStatus, error: check.error }));
  }
  try {
    const res = await ipc.seek(check.seconds);
    session.lastStatus = res.status;
  } catch (err) {
    log(`seek failed: ${err.message}`);
    return interaction.editReply(panelPayload(session, { ...session.lastStatus, error: err.message }));
  }
  panels.update(session.guildId, panelState(session, session.lastStatus));
  return interaction.editReply(panelPayload(session, session.lastStatus));
}

async function togglePlayPause(session, status, interaction) {
  try {
    const res = status.state === 'paused' ? await ipc.resume() : await ipc.pause();
    session.lastStatus = res.status;
  } catch (err) {
    log(`pause or resume failed: ${err.message}`);
    return interaction.editReply(panelPayload(session, { ...status, error: err.message }));
  }
  panels.update(session.guildId, panelState(session, session.lastStatus));
  return interaction.editReply(panelPayload(session, session.lastStatus));
}

async function skip(session, interaction) {
  try {
    const res = await ipc.skip();
    session.lastStatus = res.status;
    log(`skip: ${res.reason}`);
  } catch (err) {
    log(`skip failed: ${err.message}`);
    return interaction.editReply(panelPayload(session, { ...session.lastStatus, error: err.message }));
  }
  panels.update(session.guildId, panelState(session, session.lastStatus));
  return interaction.editReply(panelPayload(session, session.lastStatus));
}

async function handleModal(interaction) {
  if (interaction.customId === STREAMER_MODAL_ID) return handleStreamerModal(interaction);
  if (interaction.customId === VOLUME_MODAL_ID) return handleVolumeModal(interaction);
  if (interaction.customId !== SEEK_MODAL_ID) {
    return interaction.reply({ content: 'Unknown form.', flags: MessageFlags.Ephemeral });
  }
  const session = sessions.get(interaction.guildId);
  if (!session) {
    return interaction.reply({ content: 'That panel belongs to a stream that has already ended.', flags: MessageFlags.Ephemeral });
  }
  if (!canControl({ member: interaction.member, requesterId: session.requesterId, allowedRoleIds: config.allowedRoleIds })) {
    return interaction.reply({
      content: refusalMessage({ requesterId: session.requesterId, allowedRoleIds: config.allowedRoleIds }),
      flags: MessageFlags.Ephemeral,
    });
  }

  const raw = interaction.fields.getTextInputValue('seek_value');
  const parsed = parseTimeInput(raw);
  if (!parsed.ok) {
    return interaction.reply({ content: parsed.error, flags: MessageFlags.Ephemeral });
  }
  const check = clampSeek(parsed.seconds, session.lastStatus?.duration || 0);
  if (!check.ok) {
    return interaction.reply({ content: check.error, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const res = await ipc.seek(check.seconds);
    session.lastStatus = res.status;
  } catch (err) {
    log(`seek failed: ${err.message}`);
    return interaction.editReply({ content: err.message });
  }
  panels.update(session.guildId, panelState(session, session.lastStatus));
  if (session.message) await session.message.edit(panelPayload(session, session.lastStatus)).catch(() => {});
  return interaction.editReply({ content: `Seeked to ${formatDuration(check.seconds)}.` });
}

async function changeEpisode(session, interaction, delta) {
  if (isMovie(session.format)) {
    return interaction.editReply(panelPayload(session, { ...session.lastStatus, error: 'Movies do not have other episodes.' }));
  }
  const next = Number(session.episode) + delta;
  if (next < 1) {
    return interaction.editReply(panelPayload(session, { ...session.lastStatus, error: 'Already on episode 1.' }));
  }
  if (session.episodeCount && next > session.episodeCount) {
    return interaction.editReply(panelPayload(session, { ...session.lastStatus, error: 'That was the last episode.' }));
  }
  session.transitioning = true;
  try {
    await ipc.stop();
    const res = await playNext({
      malId: session.malId,
      episode: next,
      audio: session.audio,
      captions: session.captions,
      guildId: session.guildId,
      channelId: session.channelId,
      requesterId: session.requesterId,
      title: session.title,
      startAt: 0,
    });
    session.episode = next;
    session.resumeFrom = 0;
    session.lastStatus = res.status;
    if (res.channelId) session.channelId = res.channelId;
    await applyVoiceStatus(session);
  } catch (err) {
    log(`episode change failed: ${err.message}`);
    return interaction.editReply(panelPayload(session, { ...session.lastStatus, error: err.message }));
  } finally {
    session.transitioning = false;
  }
  panels.update(session.guildId, panelState(session, session.lastStatus));
  return interaction.editReply(panelPayload(session, session.lastStatus));
}

function assertStreamerManager(interaction) {
  if (canManageStreamers({
    member: interaction.member,
    ownerId: interaction.guild?.ownerId,
    allowedRoleIds: config.allowedRoleIds,
    allowedCommandRoleIds: config.allowedCommandRoleIds,
  })) return true;
  return false;
}

async function handleStreamerButton(interaction) {
  const id = interaction.customId;
  if (!assertStreamerManager(interaction)) {
    return interaction.reply({ content: 'Only the server owner, or an allowed role, can change streamers.', flags: MessageFlags.Ephemeral });
  }
  if (id === STREAMER_CHANNEL_ID) {
    pendingChannels.set(interaction.user.id, interaction.values?.[0] || null);
    return interaction.deferUpdate();
  }
  if (id === BTN.STREAMER_TOKEN) {
    return interaction.showModal(buildStreamerModal());
  }
  if (id === BTN.STREAMER_ADD) {
    return interaction.reply({
      content: 'Pick an optional voice channel, then enter the token. Leave the channel empty and the account joins a voice channel when someone streams.',
      components: [
        new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId(STREAMER_CHANNEL_ID)
            .setPlaceholder('Optional voice channel')
            .setMinValues(0)
            .setMaxValues(1)
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(BTN.STREAMER_TOKEN).setLabel('Enter token').setStyle(ButtonStyle.Primary),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (id === BTN.STREAMER_MANAGE) {
    const payload = manageMessage(await roster(), discord);
    return interaction.reply({ components: payload.components, flags: payload.flags });
  }
  if (id.startsWith('streamer:remove:')) {
    const removed = streamerStore.remove(id.slice('streamer:remove:'.length));
    if (!removed) return interaction.reply({ content: 'That private streamer is already gone.', flags: MessageFlags.Ephemeral });
    await ipc.reloadStreamers().catch((err) => log(`streamer reload failed: ${err.message}`));
    return interaction.reply({ content: 'Removed that streamer.', flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({ content: 'Unknown streamer action.', flags: MessageFlags.Ephemeral });
}

async function handleStreamerModal(interaction) {
  if (!assertStreamerManager(interaction)) {
    return interaction.reply({ content: 'Only the server owner, or an allowed role, can add streamers.', flags: MessageFlags.Ephemeral });
  }
  const token = interaction.fields.getTextInputValue('streamer_token').trim();
  const channelId = pendingChannels.get(interaction.user.id) || null;
  pendingChannels.delete(interaction.user.id);
  const known = new Set(parsePublicStreamers(config.publicStreamers).map((row) => row.token));
  if (known.has(token)) {
    return interaction.reply({ content: 'That streamer is already configured.', flags: MessageFlags.Ephemeral });
  }
  try {
    streamerStore.add({ token, channelId, addedBy: interaction.user.id });
  } catch (err) {
    return interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await ipc.reloadStreamers();
  } catch (err) {
    log(`streamer reload failed: ${err.message}`);
    return interaction.editReply({ content: 'Saved the streamer, but the streamer process did not reload. Restart it with node run.js.' });
  }
  return interaction.editReply({ content: 'Streamer added. The account will be renamed to the next Streamer letter.' });
}

function buildStreamerModal() {
  return new ModalBuilder()
    .setCustomId(STREAMER_MODAL_ID)
    .setTitle('Add streamer')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('streamer_token')
          .setLabel('User token')
          .setPlaceholder('Token is stored locally and never shown again')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true),
      ),
    );
}

/** Stop the stream, save where it reached, and blank the panel. */
async function teardown(guildId) {
  const session = sessions.get(guildId);
  if (!session) return;
  session.userStop = true;
  saveProgress(session);
  await clearVoiceStatus(session.channelId);
  try {
    await ipc.stop();
  } catch (err) {
    log(`stop failed: ${err.message}`);
  }
  panels.dropTarget(guildId);
  sessions.delete(guildId);
  if (session.message && !session.transitioning) {
    await session.message.edit(panelPayload(session, { state: 'idle' })).catch(() => {});
  }
}

async function handleVolumeModal(interaction) {
  const session = sessions.get(interaction.guildId);
  if (!session) {
    return interaction.reply({ content: 'That panel belongs to a stream that has already ended.', flags: MessageFlags.Ephemeral });
  }
  if (!canControl({ member: interaction.member, requesterId: session.requesterId, allowedRoleIds: config.allowedRoleIds })) {
    return interaction.reply({
      content: refusalMessage({ requesterId: session.requesterId, allowedRoleIds: config.allowedRoleIds }),
      flags: MessageFlags.Ephemeral,
    });
  }
  const raw = interaction.fields.getTextInputValue('volume_value').replace('%', '').trim();
  const percent = Number(raw);
  if (!Number.isFinite(percent) || percent < 1 || percent > VOLUME_MAX * 100) {
    return interaction.reply({ content: `Volume must be a number from 1 to ${VOLUME_MAX * 100}.`, flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  session.volume = percent / 100;
  try {
    const res = await ipc.volume(session.volume);
    if (res?.status) session.lastStatus = res.status;
  } catch (err) {
    log(`volume failed: ${err.message}`);
    return interaction.editReply({ content: err.message });
  }
  panels.update(session.guildId, panelState(session, session.lastStatus));
  if (session.message) await session.message.edit(panelPayload(session, session.lastStatus)).catch(() => {});
  return interaction.editReply({ content: `Volume set to ${Math.round(percent)}%.` });
}

function buildVolumeModal(volume) {
  return new ModalBuilder()
    .setCustomId(VOLUME_MODAL_ID)
    .setTitle('Custom volume')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('volume_value')
          .setLabel('Percent')
          .setPlaceholder('1 to 500')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(Math.round((volume || 1) * 100))),
      ),
    );
}

function buildSeekModal(position) {
  return new ModalBuilder()
    .setCustomId(SEEK_MODAL_ID)
    .setTitle('Seek to')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('seek_value')
          .setLabel('Position')
          .setPlaceholder('e.g. 90, 1:30 or 01:02:03')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(formatDuration(position)),
      ),
    );
}

/** Turn a streamer failure into a sentence that says what to do next. */
export function describeIpcFailure(err, ctx) {
  const message = err?.message || 'unknown error';
  if (err?.code === 'invalid_id') return `That is not a valid MAL id. ${message}`;
  if (err?.code === 'missing_episode') return `An episode number is required. ${message}`;
  if (err?.code === 'no_voice') return 'You need to be in a voice channel. Join one and try again.';
  if (/no dubbed version/i.test(message)) {
    return `There is no dubbed version of episode ${ctx.episode}. Run it again with audio: sub, or pick a series that has a dub.`;
  }
  if (/not on the video server|code 410|no episode/i.test(message)) {
    return `Episode ${ctx.episode} of MAL ${ctx.malId} is not on the video server. Check the episode number, or try audio: sub.`;
  }
  if (err?.status === 409) return message;
  if (/ECONNREFUSED|unreachable/i.test(message)) {
    return `The streamer process is not answering at ${config.ipcBaseUrl}. Start it with: node run.js streamer`;
  }
  return `Playback failed: ${message}`;
}

main().catch((err) => {
  console.error(`[${config.botName}] fatal:`, err.message);
  process.exit(1);
});
