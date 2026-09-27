# Spanish tutor

A talking Spanish conversation partner that runs entirely in your browser.
One HTML file, no build step, no server, no account.

- **It talks to you** in Spanish, slowly, at a level it adjusts as you improve.
- **You just talk.** Tap *Hablar* once and it's a conversation — it hears you
  stop, waits a couple of seconds in case you're still thinking, then answers.
  No send button, no submitting text.
- **If you go quiet it carries the conversation.** Say nothing for eight seconds
  and it speaks first — re-asking in easier words, offering you two answers to
  pick from, or starting a sentence for you to finish.
- **You can cut it off.** Tap the screen while it's talking and it stops and
  listens. With headphones on you can enable hands-free and just interrupt by
  talking over it.
- **The Spanish text starts hidden** so your ear does the work. One tap reveals it.
- **Speed it up or slow it down** mid-conversation with the 🐇 / 🐢 buttons.
- **It corrects you gently**, after it has answered, one thing per turn.
- **Say "no entiendo"** and it switches to English, explains **out loud**, then
  gives you the same idea again in easier Spanish. You do not have to be looking
  at the screen for the help to reach you.

Both timings are adjustable in settings: how long it waits after you stop
talking (default 2.5s) and how long before it fills a silence (default 8s).

### About the microphone and the speaker

On speakerphone the mic hears the tutor's own voice, so by default the mic
stands down while the tutor is speaking and comes back the instant it stops —
that's why interrupting is a screen tap rather than talking over it. Turn on
**Audífonos** in settings when you have headphones in and the mic stays live
throughout, so you can interrupt by voice.

## Your API key

The page calls the Anthropic API directly from your browser using the
`anthropic-dangerous-direct-browser-access` header, which exists for exactly
this "bring your own key" case.

Your key is stored in **your browser's localStorage on your own device**. It is
not in this repository, never uploaded anywhere but `api.anthropic.com`, and
never put in a URL. Anyone else who opens the page has to supply their own key —
they cannot use yours.

If you clear your browser data you'll need to paste it again.

## Levels

The `LEVELS` object in `index.html` is the actual syllabus — those five strings
are sent to the model verbatim:

1. Present tense only, 4–8 word sentences, the 300 most common words
2. Present plus `voy a`, 8–12 words
3. Preterite and imperfect, 12–18 words
4. All indicative tenses, commands, idioms, normal length
5. Everything, including subjunctive and regional slang, at native pace

It proposes its own checkpoint when it thinks you're ready, and the level only
ever moves **one step at a time**, whatever the model asks for.

## Tests

```
node test/test-tutor-web.js
```

47 tests, no network and no browser: the harness pulls the `<script>` block out
of `index.html` and runs it against a small fake DOM. They cover reply parsing
(including malformed replies), the level ladder, the retry policy, the
conversation clock that decides when to send and when to fill a silence, and
that the API key never reaches a URL.

## Why not Google Apps Script

The first version of this was an Apps Script web app. Apps Script serves your
page inside a Google iframe whose permission list does not include
`microphone`, so `SpeechRecognition` can never work there — no amount of code
fixes it. Speech *synthesis* works fine in that iframe; listening does not.
A plain static page on a normal HTTPS origin has no such restriction.
