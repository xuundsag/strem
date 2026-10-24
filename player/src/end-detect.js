export function playbackFinished(st, { userPaused = false, stalledMs = 0, durationStableMs = 0 } = {}) {
  if (!st) return false;
  if (st.ended || st.phase === 'ended') return true;
  if (userPaused) return false;
  const duration = Number(st.duration);
  const position = Number(st.currentTime);
  if (!(duration > 5) || !Number.isFinite(position)) return false;
  if (position < duration - 1.5) return false;
  if (stalledMs < 2000) return false;
  if (st.endList) return true;
  return durationStableMs >= 15000;
}
