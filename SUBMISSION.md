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
   they silently match nothing and the fill reports `matched: false`.
2. **Trust `matched`, not `valueNow`.** `matched` is computed in the page against the
   full value. `valueNow` is truncated to 300 characters for logging, so it will *never*
   equal a long description — comparing against it reports failure on a perfect write.
   Check `matched: true` and `truncatedByMaxLength: false`.
3. **Checkboxes and radios are clicked, not filled.** Use `click`, and only click a box
   that is currently unchecked — clicking a checked one turns it off.
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

### Award category — radio

- ✅ **Best Game** — carried by `minecraft-mcp`: Codex plays real survival through a
  mineflayer bot, with first-person vision and no creative-mode cheats.

### Built with — checkboxes

- ✅ **Codex** — the agent Relay drives; app-server is the runtime.
- ⬜ Cursor — check only if you actually used it.

### Tech tags — checkboxes

- ✅ **JavaScript / TypeScript** — every adapter and the backend.
- ✅ **React / Next.js** — the workspace UI.
- ✅ **AI / ML** — Codex drives every action.
- ✅ **Game** — `minecraft-mcp`, 28 tools driving a live survival world.

Leave unchecked: Python, Java / Kotlin, Swift, Go / Rust, Mobile, Firebase, Ramp API,
Hardware / IoT.

> **Swift and Mobile are now unchecked on purpose.** Both were justified only by the
> adapter you removed — the compiled mouse driver was the repo's only Swift, and the
> phone it drove was the only mobile surface. Leaving them checked would claim stacks
> the judges won't find in the repo.

---

## Short summary

*Replaces the version currently in the form — this field needs re-filling.*

```
Codex can reason about any app on your Mac, but it can't click a single one. Relay gives it hands. Point it at an application and it generates a local MCP adapter: screen in, clicks out, no API required. We demo it playing survival Minecraft, sending iMessages, and filling out this submission form itself.
```

---

## Long description

*Paste verbatim into the Long description textarea.*

```
THE PROBLEM

Codex can reason about any application on your Mac. It cannot touch a single one. Anything without a public API — a game, a native macOS app, an internal desktop tool — is effectively invisible to it. The standard answer is to write an integration per app, by hand, forever. Most apps never get one.

WHAT RELAY DOES

Relay gives Codex hands. You point it at an application and it generates a local MCP adapter: a small stdio server that turns that app into a set of tools the agent can call. Screen in, clicks out. The agent observes real pixels, window geometry, and game state, then acts through the same input channel a human uses.

Everything runs locally: no plugins, no app modifications, no vendor cooperation, nothing leaving the laptop.

THE GENERATOR

The interesting part isn't any single adapter — it's that Relay writes them. The flow is propose, review, generate, smoke test, register, verify. A written adapter contract is embedded in the generator's own prompt, so generated adapters and hand-written ones satisfy the same spec. New adapters are smoke-tested and registered automatically, and a generated server that fails its smoke test never reaches the agent.

WHAT WE SHIPPED

Seven adapters. The ones that carry the demo:

minecraft — 28 tools, and the most complete of the set. Codex plays real survival: perceive, gather, craft, smelt, fight, and build from actual inventory, with no /give or /setblock cheats. It has genuine eyes — a hidden prismarine-viewer renders the bot's first-person POV through headless Chromium and hands it back to the model as vision. Survival knowledge ships inside the adapter: the MCP initialize response carries a playbook, and every scan returns a recent-events memory ("took damage", "ate", "died") so the agent knows what happened between turns. Reflexes are automatic and cost zero LLM turns — auto-eat, auto-armor, auto-tool, fight back when attacked — so reasoning goes to strategy, not to staying alive. Builds export as JSON schematics for hand-off to Blender.

chrome — reads and fills web forms through injected JavaScript. It filled out this submission.

messages — sends iMessages to any number or contact.

applescript — the general escape hatch: run arbitrary AppleScript, capture the screen, observe the frontmost app. Anything without a purpose-built adapter still has a path.

obs and apple-mail apply the same contract to a streaming tool and a mail client.

ENGINEERING NOTES

Driving real desktop software is mostly a fight with undocumented behavior, and the fixes are the substance of the project:

- macOS has been quietly gutting the Messages AppleScript dictionary. Half the documented properties now throw -1728. The adapter routes around the missing ones and reports whether a message was confirmed sent rather than assuming success.
- The Messages send verb blocks on a reply that never arrives for an existing thread, but a brand-new conversation needs that round trip to deliver. Two send paths, chosen by whether a thread already exists.
- CSS nth-of-type counts siblings under one parent, not document order. Using it as a document index silently broke every checkbox on our first live run. Selectors are now full ancestor paths, verified to resolve back to the element before being returned.
- React ignores direct .value assignment, so a field can look filled and submit empty. Writes go through the prototype's native setter, dispatch input and change, and read the value back to prove it stuck.
- MCP stdio is unforgiving: one stray byte on stdout kills the transport. Every adapter keeps stdout protocol-only and routes diagnostics to stderr.

SAFETY

Filling a form is reversible. Submitting it is not. The browser adapter refuses to click submit-like controls unless a caller explicitly opts in, and that guard lives in the adapter rather than in a prompt — so an agent that gets confused fills the form and stops. This submission was filled by Relay and submitted by a human, on purpose.
```

---

## Not yet done

- [ ] **Demo URL** — Loom link, still blank.
- [ ] **Team** — needs 2–4 members; invites were still pending.
- [ ] **Short summary** — the form still holds the old text; re-fill it.
- [ ] **Human review + Submit** — the agent stops before this. Always.
