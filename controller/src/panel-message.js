import { describePanel, describeMore, describeWatched, describeHistory, describeHelp, describePing, describeStreamers, describeManage, buildContainer } from '@anime-stream/shared/panel.js';
import { MessageFlags } from 'discord.js';

export function panelMessage(state, builders) {
  return {
    content: null,
    components: [buildContainer(describePanel(state), builders)],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function watchedMessage(state, builders) {
  return {
    content: null,
    components: [buildContainer(describeWatched(state), builders)],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function helpMessage(botName, builders) {
  return {
    content: null,
    components: [buildContainer(describeHelp(botName), builders)],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function pingMessage(timing, builders) {
  return {
    content: null,
    components: [buildContainer(describePing(timing), builders)],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function streamerMessage(rows, builders) {
  return {
    content: null,
    components: [buildContainer(describeStreamers(rows), builders)],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function manageMessage(rows, builders) {
  return {
    content: null,
    components: [buildContainer(describeManage(rows), builders)],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  };
}

export function historyMessage(rows, builders) {
  return {
    content: null,
    components: [buildContainer(describeHistory(rows), builders)],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function moreOptionsMessage(state, builders) {
  return {
    content: null,
    components: [buildContainer(describeMore(state), builders)],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  };
}

export const PANEL_MESSAGE_FLAGS = MessageFlags.IsComponentsV2;
export const MORE_MESSAGE_FLAGS = MessageFlags.Ephemeral | MessageFlags.IsComponentsV2;
