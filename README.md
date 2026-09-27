# Spanish tutor

A talking Spanish conversation partner that runs entirely in your browser.
One HTML file, no build step, no server, no account.

- **It talks to you** in Spanish, slowly, at a level it adjusts as you improve.
- **You talk back** with the microphone — it keeps listening through your pauses
  and only sends when you tap the mic again, so you can take as long as you like.
- **The Spanish text starts hidden** so your ear has to do the work. One tap
  shows it when you're stuck.
- **It corrects you gently**, after it has answered, one thing per turn.
- **Say "no entiendo"** and it switches to English, explains, and goes back.

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

24 tests, no network and no browser: the harness pulls the `<script>` block out
of `index.html` and runs it against a small fake DOM. They cover reply parsing
(including malformed replies), the level ladder, the retry policy, and that the
API key never reaches a URL.

## Why not Google Apps Script

The first version of this was an Apps Script web app. Apps Script serves your
page inside a Google iframe whose permission list does not include
`microphone`, so `SpeechRecognition` can never work there — no amount of code
fixes it. Speech *synthesis* works fine in that iframe; listening does not.
A plain static page on a normal HTTPS origin has no such restriction.
