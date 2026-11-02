const YOUTUBE_EMBED_BASE = 'https://www.youtube.com/embed';

export function buildYouTubeEmbedUrl(videoIds: string[], playlistId?: string | null, autoplay = false): string | null {
  if (playlistId) {
    const autoplayParam = autoplay ? '&autoplay=1' : '';
    return `${YOUTUBE_EMBED_BASE}/videoseries?list=${encodeURIComponent(playlistId)}${autoplayParam}`;
  }

  const [firstVideoId, ...remainingVideoIds] = videoIds;
  if (!firstVideoId) return null;

  const query = remainingVideoIds.length > 0
    ? `?playlist=${encodeURIComponent(remainingVideoIds.join(','))}`
    : '';
  const autoplayParam = autoplay ? `${query ? '&' : '?'}autoplay=1` : '';

  return `${YOUTUBE_EMBED_BASE}/${encodeURIComponent(firstVideoId)}${query}${autoplayParam}`;
}

export function formatYouTubeDuration(durationSeconds: number): string {
  const totalSeconds = Math.max(0, Math.round(durationSeconds));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}
