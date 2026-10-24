import { REST, Routes, SlashCommandBuilder } from 'discord.js';

export function buildCommands(botName) {
  const stream = new SlashCommandBuilder()
    .setName('stream')
    .setDescription(`Stream an anime episode into your voice channel with ${botName}`)
    .addStringOption((o) =>
      o.setName('anime').setDescription('Anime name. Typos are fine, for example oni poice').setRequired(true),
    )
    .addNumberOption((o) =>
      o.setName('episode').setDescription('Optional. Defaults to the last watched episode, or 1. Ignored for movies').setRequired(false),
    )
    .addStringOption((o) =>
      o
        .setName('audio')
        .setDescription('Sub keeps the Japanese voice track, dub replaces it with English')
        .setRequired(true)
        .addChoices(
          { name: 'Sub (Japanese)', value: 'sub' },
          { name: 'Dub (English)', value: 'dub' },
        ),
    );

  const cont = new SlashCommandBuilder()
    .setName('continue')
    .setDescription('Continue a series you already started')
    .addStringOption((o) =>
      o.setName('anime').setDescription('One of your saved series').setRequired(true).setAutocomplete(true),
    );

  const stop = new SlashCommandBuilder().setName('stop').setDescription('End the current stream and leave voice');

  const history = new SlashCommandBuilder()
    .setName('history')
    .setDescription('List the series you have started, newest first')
    .addIntegerOption((o) => o.setName('limit').setDescription('How many to show, default 5'));

  const streamer = new SlashCommandBuilder().setName('streamer').setDescription('List the streamer accounts in this server');
  const help = new SlashCommandBuilder().setName('help').setDescription(`How to use ${botName}`);
  const ping = new SlashCommandBuilder().setName('ping').setDescription('Check how fast Jinx answers');

  return [stream, cont, stop, history, streamer, help, ping];
}

export function commandRoutes(clientId, guildId) {
  const list = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
  const item = (id) =>
    guildId ? Routes.applicationGuildCommand(clientId, guildId, id) : Routes.applicationCommand(clientId, id);
  return { list, item };
}

export async function replaceCommands(rest, { clientId, guildId, commands }) {
  const { list, item } = commandRoutes(clientId, guildId);
  const existing = await rest.get(list);
  const previous = Array.isArray(existing) ? existing : [];
  for (const cmd of previous) {
    await rest.delete(item(cmd.id));
  }
  for (const cmd of commands) {
    await rest.post(list, { body: cmd });
  }
  return { deleted: previous.map((cmd) => cmd.name), added: commands.map((cmd) => cmd.name) };
}

export async function registerCommands({ token, clientId, guildId, log = () => {} }) {
  const rest = new REST({ version: '10' }).setToken(token);
  const commands = buildCommands(process.env.BOT_NAME || 'Jinx').map((cmd) => cmd.toJSON());
  const result = await replaceCommands(rest, { clientId, guildId, commands });
  log(`deleted ${result.deleted.length} commands, added ${result.added.join(', ')}`);
  return commands;
}
