import { isMovie } from '../../shared/src/panel.js';

export function voiceStatusText({ title, episode, format }) {
  const name = String(title || 'Anime').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (isMovie(format)) return name;
  return `${name} - Episode ${episode}`.slice(0, 120);
}

export async function setVoiceStatus(rest, channelId, status) {
  if (!rest || !channelId) return { ok: false, reason: 'missing' };
  await rest.put(`/channels/${channelId}/voice-status`, { body: { status: status || '' } });
  return { ok: true };
}
