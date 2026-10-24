// A fake Discord gateway.
//
// The Streamer class talks to Discord through client.ws.broadcast() and listens
// on the client's "raw" event. Both are easy to stand in for, which lets the
// real signalling code run with no network and no account.
//
// What this proves: that joining voice, going live, stopping and leaving send
// the opcodes Discord expects, in the right order, with the right stream key.

import { EventEmitter } from 'node:events';

export class FakeGatewayClient extends EventEmitter {
  constructor() {
    super();
    this.user = { id: '111111111111111111', tag: 'Jinx#0001' };
    this.token = 'fake-user-token';
    this.sent = [];
    this.ws = {
      broadcast: (packet) => {
        this.sent.push(packet);
      },
    };
  }

  /** Every packet of a given opcode, in order. */
  opcodes(code) {
    return this.sent.filter((p) => p.op === code).map((p) => p.d);
  }

  /** Feed the client a gateway dispatch, as Discord would. */
  dispatch(type, data) {
    this.emit('raw', { t: type, d: data });
  }
}

/** Build a Streamer wired to the fake client. */
export async function makeStreamer() {
  const { Streamer } = await import('@dank074/discord-video-stream');
  const client = new FakeGatewayClient();
  const streamer = new Streamer(client);
  return { client, streamer };
}

/** Complete a joinVoice handshake against the fake gateway. */
export async function completeJoin(client, streamer, { guildId = '123456789012345678', channelId = '987654321098765432', userId = '111111111111111111' } = {}) {
  const pending = streamer.joinVoice(guildId, channelId);
  // The client asked to join; Discord answers with a session and a server.
  client.dispatch('VOICE_STATE_UPDATE', { user_id: userId, guild_id: guildId, channel_id: channelId, session_id: 'sess-1' });
  client.dispatch('VOICE_SERVER_UPDATE', { guild_id: guildId, endpoint: 'voice.example.discord.gg', token: 'voice-token' });
  return pending;
}
