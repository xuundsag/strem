// The capture audio path.
//
// The null sink has to run at 48000. Discord's voice stack wants 48000, and
// the default PulseAudio sink rate is 44100, so without an explicit rate FFmpeg
// resamples every frame and it comes through as crackle.
//
// There is also a trap: adding latency_usec to module-null-sink parses fine but
// makes the sink silently fall back to 44100. Both halves are checked here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { NullSinkAudio } from '../../player/src/display.js';
import { ScreenCapture } from '../../player/src/capture.js';
import { checkSystemTools } from '../../player/src/display.js';

const tools = checkSystemTools();
const skip = tools.pulse ? false : 'pulseaudio is not installed';

test('the null sink runs at 48000 Hz', { skip }, async (t) => {
  const audio = new NullSinkAudio({ log: () => {} });
  await audio.start();
  t.after(() => audio.stop());
  if (!audio.started) return t.skip('the sink did not come up on this box');

  const out = execFileSync('pactl', ['list', 'sinks'], { env: audio.env }).toString();
  const spec = (out.match(/Sample Specification: (.*)/) || [])[1] || '';
  assert.match(spec, /48000Hz/, `sink is ${spec}, expected 48000Hz`);
});

test('the capture asks for 48000 output', () => {
  const capture = new ScreenCapture({ display: ':99', pulseSource: 'animestream_sink.monitor' });
  const args = capture.buildArgs();
  const ar = args[args.indexOf('-ar') + 1];
  assert.equal(ar, '48000');
  const ac = args[args.indexOf('-ac') + 1];
  assert.equal(ac, '2');
  assert.ok(args.includes('libopus'), 'Discord wants Opus');
});

test('the capture gives x11grab a queue and wall clock timestamps', () => {
  // Without a thread queue a slow frame is dropped and the audio slips against
  // the video. Without wall clock timestamps x11grab's own clock drifts.
  const capture = new ScreenCapture({ display: ':99', pulseSource: 'animestream_sink.monitor' });
  const args = capture.buildArgs();
  const grabAt = args.indexOf('x11grab');
  assert.ok(grabAt > 0);
  const beforeInput = args.slice(grabAt, args.indexOf('-i', grabAt));
  assert.ok(beforeInput.includes('-thread_queue_size'), 'x11grab needs a thread queue');
  assert.ok(beforeInput.includes('-use_wallclock_as_timestamps'), 'x11grab needs stable timestamps');
});
