# Relay — Devpost / OpenAI Build Week submission content

Source of truth for the Devpost submission (OpenAI Codex + GPT-5.6 hackathon).
Fill values here, then paste into the form step by step.

> **AI-content rule (from the submit page):** you *may* use AI to help write and
> structure this, but the description you paste must accurately reflect what you
> built, and **you must name the project yourself** — don't let AI name it. Read
> everything below and edit in your own voice before pasting. Judges read these and
> can tell.

> **Repo access:** this hackathon requires the code repo be shared with
> `testing@devpost.com` **and** `build-week-event@openai.com`. Do that before you submit.

---

## Step 1 — Project overview

### Project name (required, ≤60 chars)

```
Relay
```

*Own this yourself — the rules explicitly say don't let AI pick the name. `Relay`
comes from your README; keep it or change it, but decide deliberately.*

### Elevator pitch / tagline (required, ≤200 chars)

*Currently 178 chars.*

```
Codex can reason about any Mac app but can't click one. Relay generates a local MCP adapter for any app — screen in, clicks out. No API, no plugin, nothing leaves your laptop.
```

### Thumbnail

`<< upload a 3:2 image — the workspace UI mid-run, or the Minecraft duel frame >>`

---

## Step 2 — Project details (public project page)

### Built with (tags — up to 25)

```
TypeScript, JavaScript, Node.js, Codex, GPT-5.6, Codex app-server, Model Context Protocol (MCP),
JSON-RPC, stdio, Fastify, Server-Sent Events, Next.js, React, shadcn/ui, Vercel AI SDK,
Swift, AppleScript, SQLite, mineflayer, OBS WebSocket, iPhone Mirroring, macOS, tsx
```

### "Try it out" links

```
GitHub: https://github.com/ryankamiri/codex-adapters
```

`<< add a Loom/YouTube demo link here too if you want it on the public page >>`

### Image gallery

`<< up to 15 images. Suggested: (1) workspace UI streaming a turn, (2) the generator
CLI proposing then writing an adapter, (3) Minecraft duel frame, (4) Clash Royale on
the mirrored iPhone, (5) the adapter table from the README. 3:2, ≤5MB each. >>`

### Video demo link (required — YouTube/Vimeo, embedded at top of page)

`<< paste the YouTube URL. Must be public and under 3 minutes. Script below. >>`

### About the project (required — Markdown, LaTeX supported)

> Paste the block below into the "About the project" textarea, then **edit it into
> your own voice**. It is accurate to the current code (see the accuracy notes at the
> bottom of this file). Do not paste it verbatim and call it done.

```markdown
## Inspiration

Codex can reason about almost any application on your Mac. It can't touch a single
one. Anything without a public API — a game, a native macOS app, an internal tool
your company wrote in 2009 — is invisible to an agent. The usual fix is to write an
integration per app, by hand, forever, and most apps never get one.

We wanted to remove the "by hand." You describe an app you want your agent to drive,
and the system writes the adapter for it, tests it, and registers it — on your
machine, for your apps, in a couple of minutes.

## What it does

Relay turns any Mac app into a set of tools Codex can call, using the Model Context
Protocol (MCP). Two pieces:

1. **A generator.** You give it an intent ("control Spotify: play, pause, skip") and
   it authors a working local MCP adapter, smoke-tests it, and registers it with
   Codex. A generated adapter that fails its smoke test is never registered, so
   broken code never reaches your agent.

2. **Seven reference adapters** proving the same contract works across
   fundamentally different ways of reaching an app: a network game protocol
   (Minecraft), synthetic input on a mirrored iPhone (Clash Royale), injected
   JavaScript (Chrome), AppleScript + SQLite (Messages), app scripting (OBS), and a
   general AppleScript escape hatch.

Every adapter implements the same triad: `observe_*` (cheap read-only state),
action tools (verbs that change the app), and `capture_*` (writes an artifact file
and returns its path). Artifacts are how apps hand off to each other — Minecraft
exports a build as JSON, and the next adapter reads it.

## How we used Codex and GPT-5.6

Codex isn't a feature of Relay — it's the whole runtime. Relay spawns `codex
app-server` as a child process and drives it over newline-delimited JSON-RPC on
stdio. Everything is a Codex turn:

- **The generator is two Codex turns on one persistent thread.** Turn A runs
  read-only and proposes a toolkit (Codex reads our adapter contract and the app's
  docs, then emits a JSON tool spec). Turn B runs with write access scoped to the
  `adapters/` directory and no network, and writes the real `server.mjs`. Because
  both turns share a thread, the implementation still remembers why it proposed each
  tool.

- **At runtime, Codex drives the apps directly.** Our backend never calls an adapter
  tool itself — it starts a turn and streams events. GPT-5.6 decides which MCP tools
  to call, in what order, to satisfy the request. The workspace UI pulls the live
  model catalog from the app-server (`model/list`) and lets you pick across the
  GPT-5.6 family; the frontier model, GPT-5.6-Sol, is the default.

- **We built Relay with Codex.** Much of this project was authored through Codex
  during the hackathon, and one of our own adapters (`chrome-mcp`, a Codex-driven
  adapter) filled out a submission form for us — then refused to click Submit,
  because that guard lives in the adapter, not a prompt.

## How we built it

A Fastify backend owns one long-lived `codex app-server` process and multiplexes
concurrent chat threads onto it over stdio JSON-RPC, serializing turns with a
promise-chain mutex so overlapping requests queue instead of colliding. It streams
each turn to a Next.js + shadcn workspace UI as Server-Sent Events. Each adapter is
an independent child process speaking MCP on stdio; new ones hot-reload without
restarting the app-server.

## Challenges we ran into

Driving real desktop software is mostly a fight with undocumented behavior:

- **macOS is quietly gutting the Messages AppleScript dictionary** — half the
  documented properties now throw `-1728`. The adapter routes around the missing
  ones and reports whether a send was *confirmed* rather than assuming success.
- **`send` blocks forever on an existing thread but a new conversation needs the
  round trip.** Two send paths, chosen by whether the thread already exists.
- **CSS `nth-of-type` counts siblings, not document order** — using it as "the Nth
  input on the page" silently broke every checkbox on our first live run. Selectors
  are now full ancestor paths, verified to resolve back to the element.
- **React ignores direct `.value` assignment**, so a field looks filled and submits
  empty. Writes go through the prototype's native setter, dispatch `input`/`change`,
  then read back to prove it stuck.
- **Rendering a headless first-person view cost ~430MB per instance** and multiplied
  across superseded adapters. We dropped it and now capture the real screen instead —
  which also makes demos legible, because you see exactly what the agent sees.
- **stdout is protocol-only** — one stray byte kills the MCP transport, so every
  adapter sends all diagnostics to stderr and a log file.

## What we learned

One contract, deliberately vague about *how* you reach an app, generalizes across
network protocols, accessibility trees, injected JS, and synthetic clicks — because
the agent only ever sees tools. And the safety boundary belongs in the adapter, not
the prompt: `chrome-mcp` refuses submit-like controls unless a caller explicitly
opts in, so a confused agent fills a form and stops.

## What's next

More generated adapters, a tighter review loop for the proposed toolkit, and
app-to-app artifact hand-off as a first-class workflow.
```

---

## Step 3 — Additional info (for judges & organizers)

### Submitter Type (required, dropdown)

`<< pick: Individual / Team — you're a team of 3 >>`

### Country of Residence (required)

`<< select — one per teammate as required >>`

### Which category are you submitting to? (required, dropdown)

`<< pick the best-fit category from the dropdown. Relay is a developer tool /
automation project; if there's a "dev tools" or "productivity/automation" option,
that's the fit. If a game category exists and you lead the video with the Minecraft
duel or Clash Royale, that's the alternative. >>`

### Code repo URL (required — README must highlight how Codex & GPT-5.6 were used)

```
https://github.com/ryankamiri/codex-adapters
```

- ✅ README exists and explains the architecture and Codex usage.
- ⚠️ Confirm the README's "how Codex & GPT-5.6 were used" is explicit (see accuracy
  note #1 below — add GPT-5.6 by name if judges expect it called out).
- ⚠️ Share the repo with `testing@devpost.com` **and** `build-week-event@openai.com`
  (required if private).

### Link for judges to test + instructions (not public)

```
This is a local macOS developer tool — there is no hosted URL. To run it:

1. git clone https://github.com/ryankamiri/codex-adapters
2. cd codex-adapters && npm install
3. Have the `codex` CLI installed and authenticated (Relay drives `codex app-server`).

Generate an adapter for any app (no UI needed):
   npm run generate -- new spotify --intent "control Spotify: play, pause, skip, search"

Run the workspace UI to watch Codex drive apps:
   npm run dev:backend                         # Fastify + codex app-server on :4000
   cd frontend && npm install && npm run dev   # workspace UI on :3000

macOS permission grants (Automation, Accessibility, Full Disk Access, Screen
Recording, and Chrome's "Allow JavaScript from Apple Events") are documented in the
README under "macOS permissions" — required because the adapters drive real apps.
```

### /feedback Session ID (required)

```
<< paste the /feedback Codex Session ID where the majority of the project was worked
   on — a string of letters/numbers. See the hackathon FAQs for where to find it. >>
```

### Plugin / dev-tool installation instructions (Relay IS a dev tool — fill this)

```
Relay is a local CLI + backend, macOS only.

Requirements: Node.js, the `codex` CLI (authenticated), macOS. Optional per-adapter:
OBS 28+ with WebSocket for obs-mcp; a Minecraft server with the bot opped for
minecraft-mcp; iPhone Mirroring for clash-royale-mcp.

Install:
  git clone https://github.com/ryankamiri/codex-adapters && cd codex-adapters && npm install

Generate an adapter:
  npm run generate -- new <name> --intent "<what the agent should be able to do>"
  # add --review to approve the tool surface before code is written

The generator smoke-tests and registers each adapter into ~/.codex/config.toml
automatically. Supported platform: macOS. Full permission setup is in the README.
```

### Upload a file (optional)

`<< optional: zip of any extra material, or skip >>`

---

## Step 4 — Submit checklist (from the final page)

- [ ] Demo video is **under 3 minutes**, **public on YouTube**, link correct in form
- [ ] Voiceover explains **what you built, how you used Codex, and how you used GPT-5.6**
- [ ] `/feedback` Codex Session ID retrieved and entered
- [ ] Private repo shared with **testing@devpost.com** and **build-week-event@openai.com**
- [ ] README has setup instructions and explains Codex + GPT-5.6 usage
- [ ] Installation instructions + judge testing path included (done above)
- [ ] All 3 team members added and accepted: **@kilehsu, @AadiBiyani, @ryankamiri**
- [ ] Category selected
- [ ] Submission is **not** left as a draft

---

## Suggested 3-minute demo video script

Lead with the product (the generator — it always works), close with the wow moment.
The rules want your voiceover to name Codex and GPT-5.6 explicitly.

**0:00–0:20 — The problem.** "Codex, running on GPT-5.6, can reason about any app on
my Mac. It can't click a single one." Show a native app with no API.

**0:20–1:10 — The generator (core).** Run
`npm run generate -- new spotify --intent "..."`. Narrate: Codex reads our adapter
contract, proposes a toolkit read-only, then writes and smoke-tests a real MCP
server — a failed smoke test is never registered. Show the tool appear in
`~/.codex/config.toml`, then ask the agent to drive Spotify.

**1:10–2:00 — Breadth.** Flash the workspace UI driving 2–3 adapters (Chrome filling
a form and refusing submit; Messages sending an iMessage). One contract, many ways to
reach an app.

**2:00–2:50 — The wow moment.** The iMessage-triggered Minecraft duel: text a
trusted number, Codex starts recording in OBS, runs `duel_player` against a live
challenger, and texts back the result. (See accuracy note #2 — film this live; it's
wired but requires a configured private harness config.)

**2:50–3:00 — Close.** "Any app, any Mac, in a couple of minutes — built with Codex."

---

## ⚠️ Accuracy notes — read before you submit (judges will test the repo)

1. **GPT-5.6 is not hardcoded in the repo.** The code drives `codex app-server` and
   asks it for the live model catalog (`model/list`); it defaults to the account's
   frontier model, which on our machines is **GPT-5.6-Sol** (the GPT-5.6 family:
   Sol/Terra/Luna). This is accurate to say, but the *repo* doesn't pin a model
   string. Since this hackathon requires highlighting GPT-5.6, consider adding one
   explicit line to the README naming GPT-5.6 as the model Relay runs on. Don't claim
   a hardcoded default that isn't there.

2. **The iMessage → Minecraft → OBS demo is wired but not shipped-on by default.**
   The mechanism is fully implemented (`duel_player` is real; the harness, approval
   policy, and OBS recording all exist). But the checked-in example config only
   allowlists `applescript-mcp` and `messages-mcp` — to run the Minecraft duel flow
   you must add `minecraft-mcp` and `obs-mcp` to a private, untracked
   `config/imessage-harness.json`, op the bot on a running server, and grant
   permissions. Describe it as "built and demoed live," not "runs out of the box."

3. **Minecraft vision is a real-screen capture, not a headless render.** The README
   still says the POV is "rendered headless." The current code drops that (it cost
   ~430MB/instance) and uses `screencapture` of the real screen instead. Fix the
   README line, and describe vision as "the agent sees the real game screen." The
   `SUBMISSION.md` on `main` and the `feat/submission-content` branch both still
   carry the outdated headless-POV claim — don't repeat it here.

4. **Two prior submission drafts disagree.** `SUBMISSION.md` (Ramp Builders Cup form)
   leads with Clash Royale; the unmerged `feat/submission-content` branch leads with
   Minecraft. This file is for the **Devpost/OpenAI** form and is independent of both.
```