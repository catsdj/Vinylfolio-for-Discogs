import test from 'node:test';
import assert from 'node:assert/strict';

import { buildYouTubeEmbedUrl, formatYouTubeDuration } from './youtubeEmbed.ts';

test('builds an embeddable YouTube sequence URL from video IDs', () => {
  assert.equal(
    buildYouTubeEmbedUrl(['firstVideo', 'secondVideo', 'thirdVideo']),
    'https://www.youtube.com/embed/firstVideo?playlist=secondVideo%2CthirdVideo'
  );
});

test('builds a playlist embed URL when a real playlist ID is available', () => {
  assert.equal(
    buildYouTubeEmbedUrl([], 'PL123'),
    'https://www.youtube.com/embed/videoseries?list=PL123'
  );
});

test('returns no URL when there are no valid video IDs or playlist ID', () => {
  assert.equal(buildYouTubeEmbedUrl([]), null);
});

test('adds autoplay to an embed URL after a playlist item is selected', () => {
  assert.equal(
    buildYouTubeEmbedUrl(['firstVideo', 'secondVideo'], null, true),
    'https://www.youtube.com/embed/firstVideo?playlist=secondVideo&autoplay=1'
  );
});

test('formats duration seconds for the video list', () => {
  assert.equal(formatYouTubeDuration(410), '6:50');
  assert.equal(formatYouTubeDuration(45), '0:45');
});
