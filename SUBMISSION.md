# Relay — Builders Cup submission content

Source of truth for the submission at <https://builders-cup.ramp.com/>.
Edit values here, then have the agent fill the form from this file.

**The agent must never submit.** Fill every field, then stop and report
"ready for submission" so a human reviews and clicks Submit.

---

## How to fill this form

Prompt the agent with:

> Use chrome-mcp to fill the Ramp Builders Cup form at builders-cup.ramp.com from
> SUBMISSION.md. Call inspect_form first and use the selectors it returns. Fill every
> field in the Field values table, check the listed checkboxes, select the radio.
> Do NOT submit — stop when the form is filled and tell me it's ready for review.

Rules the agent must follow:

1. **`inspect_form` first, always.** Use the selectors it returns verbatim. Guessed
   selectors (`input[name="title"]`, `input:nth-of-type(2)`) are the top failure mode —
   they silently match nothing and `fill_field` reports `matched: false`.
2. **Check `valueNow` after every fill.** If it doesn't echo the value back, the write
   was rejected — retry with the selector from a fresh `inspect_form`.
3. **Checkboxes and radios are clicked, not filled.** Use `click`, and only click a box
   that is currently unchecked (clicking a checked one turns it off).
4. **Never pass `allowSubmit: true`.** The adapter refuses submit-like controls by
   default; that guard is the point. Leave it on.

---

## Field values

| Field | Value |
| --- | --- |
| **Project title** (required, ≤60) | `Relay` |
| **Short summary** (required, ≤500) | see [Short summary](#short-summary) |
| **Long description** (optional, ≤4000) | see [Long description](#long-description) |
| **GitHub repository URL** (required) | `https://github.com/ryankamiri/codex-adapters` |
| **Demo URL** (optional) | _fill in the Loom link before submitting_ |
| **Custom tag** (≤24) | `MCP adapters` |

### Award category — radio, pick one

- ✅ **Save Time. Save Money.** — Relay is developer automation; this is the fit.
- ⬜ Best Game — only if you want to lead with the Clash Royale demo instead.

### Built with — checkboxes

- ✅ **Codex** — the agent Relay drives; app-server is the runtime.
- ⬜ Cursor — check only if you actually used it.

### Tech tags — checkboxes

- ✅ **JavaScript / TypeScript** — every adapter and the backend.
- ✅ **Swift** — `mouse.swift`, the compiled click driver.
- ✅ **React / Next.js** — the workspace UI.
- ✅ **AI / ML** — Codex drives every action.
- ✅ **Game** — Clash Royale and Minecraft adapters.
- ✅ **Mobile** — Clash Royale runs on a mirrored iPhone.

Leave unchecked: Python, Java / Kotlin, Go / Rust, Firebase, Ramp API, Hardware / IoT.

---

## Short summary

*287 / 500 — already filled in the form; re-fill only if it comes back empty.*

```
Codex can reason about anything, but it can't click anything. Relay gives it hands for any app on your Mac — even ones with no API. Point it at an app and it generates a local MCP adapter: screen in, clicks out. We demo it playing Clash Royale on a mirrored iPhone and sending iMessages.
```

---

## Long description

*Paste verbatim into the Long description textarea.*

```
THE PROBLEM

Codex can reason about any application on your Mac. It cannot touch a single one. Anything without a public API — a game, a native macOS app, an internal desktop tool — is effectively invisible to it. The standard answer is to write an integration per app, by hand, forever. Most apps never get one.

WHAT RELAY DOES

Relay gives Codex hands. You point it at an application and it generates a local MCP adapter: a small stdio server that turns that app into a set of tools the agent can call. Screen in, clicks out. The agent observes real pixels and window geometry, then acts through synthetic input — the same channel a human uses.

Everything runs locally. No plugins, no app modifications, no vendor cooperation, and no screen data leaving the laptop.

THE GENERATOR

The interesting part isn't any single adapter — it's that Relay writes them. The flow is propose → review → generate → smoke test → register → verify. A written adapter contract is embedded in the generator's own prompt, so generated adapters and hand-written ones satisfy the same spec. New adapters are smoke-tested and registered automatically; a generated server that fails its smoke test never reaches the agent.

WHAT WE SHIPPED

Seven adapters, all driving live applications:

- clash-royale — plays a real match on a mirrored iPhone. Card deploys go through a compiled Swift mouse driver because AppleScript clicks were not pixel-accurate enough to place a troop on a specific tile.
- messages — sends iMessages to any number or contact.
- chrome — reads and fills web forms via injected JavaScript. It is what filled out this submission.
- applescript — a general escape hatch: run arbitrary AppleScript, capture the screen, observe the frontmost app.
- minecraft, obs, apple-mail — the same contract applied to a game, a streaming tool, and a mail client.

ENGINEERING NOTES

Driving real desktop software is mostly a fight with undocumented behavior, and the fixes are the substance of the project:

- macOS has been quietly gutting the Messages AppleScript dictionary. Half the documented properties now throw -1728. The adapter routes around the missing ones and reports whether a message was actually confirmed sent rather than assuming success.
- The Messages send verb blocks on a reply that never arrives for existing threads, but a new conversation needs that round trip to deliver. Two different send paths, chosen by whether a thread already exists.
- CSS nth-of-type counts siblings under one parent, not document order. Using it as a document index silently broke every checkbox on our first live run. Selectors are now full ancestor paths, verified to resolve back to the element before being returned.
- React ignores direct .value assignment, so a field can look filled and submit empty. Writes go through the prototype's native setter and dispatch input and change, then read the value back to prove it stuck.
- MCP stdio is unforgiving: one stray byte on stdout kills the transport. Every adapter keeps stdout protocol-only and sends all diagnostics to stderr and a log file.

SAFETY

Filling a form is reversible. Submitting it is not. The browser adapter refuses to click submit-like controls unless a caller explicitly opts in, enforced in the adapter rather than left to prompting — so an agent that gets confused fills the form and stops. This submission was filled by Relay and submitted by a human on purpose.
```

---

## Not yet done

- [ ] **Demo URL** — Loom link, still blank.
- [ ] **Team** — needs 2–4 members; invites were still pending.
- [ ] **Human review + Submit** — the agent stops before this. Always.
