Slate
Slate watches a camera feed and directs the shot itself — no editor, no pre-written script for what to say. It scores what it sees, decides what's wrong, says so out loud, and prints the take once the shot actually holds up.

Built for [hackathon name] — Agentic Cinema track.

Why this counts as agentic
There are three decision points running in a loop, not a single generate call:

Perception — every ~0.6s it reads the raw frame and scores it on three signals: framing (rule-of-thirds + subject size, found via a skin-tone blob, no model download needed), motion energy (frame differencing), and light (brightness + contrast histogram).
Director — picks whichever signal is weakest, decides what to say about it, and varies the phrasing if the same problem keeps coming up instead of repeating itself. What it says depends on the scene brief you type in (a "nervous, waiting" scene wants stillness; an "action" scene wants energy), so the same shot gets judged differently depending on intent.
Cut agent — tracks how long the shot has held above threshold on all three signals at once, and only prints the take once it's held for a few consecutive reads. It doesn't cut on a timer.
Everything it decides is written out live in the notes panel, so you can watch the reasoning, not just the output.

Stack
Plain HTML/CSS/JS. The computer-vision part is done by hand with canvas pixel math — no ML model to download, so it works with no internet at all once the page is loaded. Voice is the browser's built-in speech synthesis.

Running it
Open index.html directly, or serve the folder:

python3 -m http.server 8000
Then visit localhost:8000. Allow camera access, or use the "use a clip" file picker if you'd rather run it against a pre-recorded video (also the fallback if the venue camera misbehaves mid-demo).

Deploying (for the "live product" link)
It's a static folder, so any of these take about a minute:

Netlify Drop — drag the folder onto https://app.netlify.com/drop
GitHub Pages — push this repo, then enable Pages on the main branch
Vercel — vercel from inside the folder
Demo script (under 3 minutes)
Type a one-line scene brief ("nervous, waiting for news").
Hit Roll camera, step in front of it slightly off-frame.
Let it call you out — it'll say what's wrong out loud and the notes panel shows why.
Correct it. Watch the meters go green and the shot get printed automatically into the filmstrip at the bottom.
Change the brief to something high-energy and show the same shot now gets judged differently.
Known limits
The framing detector uses a skin-tone heuristic, so it can be thrown off by strong colored lighting or a very warm/cool white balance. If that happens on stage, switch the brief's target or use the file-upload fallback with a pre-tested clip.
