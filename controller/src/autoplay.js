export function autoplayPlan(session) {
  if (!session?.autoplay) return { action: 'finish' };
  const next = Number(session.episode) + 1;
  if (!Number.isFinite(next) || next <= 0) return { action: 'finish', reason: 'bad episode' };
  if (session.episodeCount && next > session.episodeCount) {
    return { action: 'finish', reason: 'no more episodes' };
  }
  return { action: 'advance', episode: next };
}
