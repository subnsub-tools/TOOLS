# Melody Catcher

The engine behind the
[Melody Catcher tab on subnsub.com](https://subnsub.com) — audition
piano pitches, keep the ones that match the tune in your head, replay
the captured sequence at any tempo, and move it in/out as a standard
MIDI file. Published so the "100% local — nothing leaves the browser"
claim is auditable and the melody format is independently readable:
Web Audio synthesis, the sequence format, playback scheduling, and a
from-scratch SMF writer/parser.

## Files

- [`melody-core.js`](melody-core.js) — the module: pitch helpers,
  `sanitizeSequence()`, the synth (`audition()`, `voice()`,
  `holdVoice()`, `stopAllVoices()`, `resumeAudio()`), `createPlayer()`,
  `buildMidi()` / `midiFileName()`, `parseMidi()` / `midiToMelody()`
- [`demo.html`](demo.html) — minimal standalone page exercising the module

## Sequence format

A melody is a plain JSON array, one entry per one-beat slot: a MIDI note
number within the 88-key piano range (`21` = A0 … `108` = C8) or the
string `'R'` for a rest.

```json
[60, 62, 64, "R", 67, 67]
```

`sanitizeSequence()` is the single gate any external payload passes
through — it keeps rests and in-range numbers and drops everything else.

## Usage

```js
import {
  noteName, freq, isBlack, inScale, sanitizeSequence,
  audition, resumeAudio, createPlayer,
  buildMidi, midiFileName, parseMidi, midiToMelody,
} from './melody-core.js';

noteName(60);            // "C4"
audition(60);            // click-a-key tone (0.7 s), resumes audio itself

const player = createPlayer({
  bpm:  () => Number(slider.value),   // re-read each pass — tempo changes land on the next loop
  loop: () => loopBox.checked,
  onSlot: (i, item) => highlight(i),  // fires as slot i begins sounding
  onStop: () => resetPlayButton(),
});
player.play(seq);        // toggle: call again (or player.stop()) to stop

// MIDI out: one slot = one quarter note, tempo embedded
const bytes = buildMidi(seq, 100);            // → Uint8Array (.mid, format 0)
const name  = midiFileName(seq);              // melody-C4-Ds4-E4-<stamp>.mid

// MIDI in: flattens any format-0/1 file onto the slot model
const { seq: loaded, bpm } = midiToMelody(parseMidi(await file.arrayBuffer()));
```

Call `resumeAudio()` (or just `audition()` / `player.play()`) from a user
gesture — autoplay policies keep the AudioContext suspended until then.

## Model notes

- **Voice**: triangle at *f* + sine at 2·*f* (mixed at 0.16) through a
  lowpass at 7·*f* (capped 9 kHz), 5 ms exponential attack, exponential
  release across the note — a soft plucked tone across the whole range.
- **Scheduling**: each pass is laid out on the *audio clock*; the next
  loop pass is anchored to the previous pass's exact end, so looping is
  seamless with no `setTimeout` drift. Edits during playback should
  `stop()` first (the site does).
- **MIDI import** is deliberately opinionated, because the strip model is
  a run of equal one-beat slots: tracks merge, chords collapse to their
  top note (skyline), note starts snap to the coarsest grid that fits
  every gap, rests fill the silence, channel-10 percussion is skipped.
  Format-2 files, SMPTE timing and files over 1000 slots are rejected with
  `Error('midi')`; other malformed input is parsed defensively (best-effort
  over the chunks it can read) rather than trusted. A file written by
  `buildMidi()` round-trips exactly.

## Site integration (not in this repo)

On subnsub.com the captured strip persists via the account's settings
sync, and signed-in users also get a server-side melody library
(save/load named melodies across devices) and QR sharing — those layers
live in the site, not in this module; the payloads they carry are the
sequence format above.
