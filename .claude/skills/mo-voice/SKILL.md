---
name: mo-voice
description: How Mo writes what it says out loud. Use when adding or changing any line Mo speaks or shows as a reply (server/speech.js), or anything that calls Fish Audio for Mo's voice. Covers the tone, Fish Audio's emotion cues, and the rule that cues are spoken, never shown.
---

# Mo's voice

Mo talks back with Fish Audio. Every reply is written **once**, with Fish Audio cues in square brackets, then split:

- **Spoken:** the line *with* its cues goes to Fish Audio, so the voice sounds pleased, gentle or excited.
- **Shown:** the same line *without* the cues goes in Mo's bubble and the panel. Users never see `[excited]`.

`server/speech.js` does the split (`spokenAndShown`) and holds every line Mo says. Add new lines there, following
this guide, and add a test for anything new.

## Who Mo sounds like

A friendly, quick colleague who's good at boring jobs and pleased to help: warm, plain, a little playful, never
gushing, never robotic. Mo is talking to someone mid-task, so it keeps it short.

## Writing rules

1. **Say what's shown.** The voice says exactly the words in the bubble (only the cues differ), so the person never
   has to read. Keep Mo's own words short (one or two sentences); a detail it passes on (a question, an answer, why
   it stopped) is said in full, up to about 400 characters.
2. **Plain spoken English.** Contractions ("I've", "that's"), no jargon ("decision", "adapter", "session"), no IDs,
   no URLs, no emoji (emoji are read out or dropped).
3. **Say the result first**, then what's next: "All done. Ten accounts created, one needs a look."
4. **Numbers as people say them:** "ten", "one needs a look"; digits are fine for big numbers ("forty-seven" or "47").
5. **When stuck, ask clearly**, in the first person: "I got stuck on this one. Can you show me how?"
6. **Say a found answer as found:** "Found it. [break] …answer…". Keep the answer itself unchanged.
7. **Vary it a little.** Each event has two or three versions, so repeated runs don't sound canned.

## Fish Audio cues (s2 models)

Cues are free-form words in **square brackets**, placed **before** the words they colour:

| Use | Cue examples | Notes |
| --- | --- | --- |
| Emotion | `[pleased]`, `[warm]`, `[excited]`, `[gentle]`, `[apologetic]`, `[curious]` | Start of a sentence; **one** per sentence |
| Intensity | `[slightly excited]`, `[very pleased]` | Use sparingly |
| Tone | `[soft]`, `[whispering]` | Rarely right for Mo |
| Emphasis | `This is [emphasis] really important.` | Right before the word |
| Pause | `[break]`, `[long-break]` | Between a result and its detail |
| Sounds | `[laughing] Ha`, `[sighing]` | Almost never for Mo; add matching words if used |

Rules: at most three cues in a sentence (Fish's own advice), usually one. `(parentheses)` are the old s1 syntax:
don't use them. Cues never carry meaning the text doesn't: the shown text must make sense on its own.

| Moment | Written once | Spoken (to Fish) | Shown |
| --- | --- | --- | --- |
| Task done | `[pleased] All done!` | same | All done! |
| Done using a lesson | `[warm] Done, the way you showed me.` | same | Done, the way you showed me. |
| Stuck | `[apologetic] I got stuck on this one. [break] Can you show me how?` | same | I got stuck on this one. Can you show me how? |
| Batch with a problem | `[pleased] Ten done. [break] [gentle] One needs a look.` | same | Ten done. One needs a look. |
| Answer found | `[warm] Found it. [break] 3 November.` | same | Found it. 3 November. |

## Fish Audio settings

- Model: `s2.1-pro` (production) or `s2.1-pro-free` (testing; no speed or reliability promise). Header `model:`.
- Voice: a library voice ID in `FISH_VOICE_ID` (`reference_id` in the request). Mo's voice is a friendly, young,
  conversational one, not the deep narrator used in the films.
- Format `mp3`, `latency: "balanced"` for short replies, `normalize: true` so numbers and dates read naturally.
- The API key stays on the server (`FISH_API_KEY`); the extension asks the server, never Fish directly.
- The extension plays every line in its offscreen page (`voice.js`, reason `AUDIO_PLAYBACK`), from the panel and from
  runs started by voice with the panel closed, so a reply after a long run isn't blocked as autoplay. If Fish has no
  audio, the computer's best system voice says the same words.
- Audio is cached by voice + text, so common lines ("All done!") play instantly after the first time.
