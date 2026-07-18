#!/usr/bin/env node
// chrome-mcp — drive a Google Chrome tab through AppleScript + injected JavaScript.
// stdout is reserved for newline-delimited JSON-RPC; diagnostics go to stderr.
//
// Requires Chrome: View > Developer > Allow JavaScript from Apple Events.
// Without it, every JS call fails with error -2700 and the tools report that hint.
//
// Safety: `click` refuses anything that looks like a submit control unless the
// caller passes allowSubmit:true. Filling a form is reversible; submitting it is
// not, so the destructive half is opt-in rather than the default.

import readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../_shared/debug-log.mjs";

const log = createLogger("chrome-mcp");
const execFileAsync = promisify(execFile);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const toolResult = (id, text, isError = false) =>
  send({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
  });

const CHROME_APP = process.env.CHROME_APP || "Google Chrome";

const TOOLS = [
  {
    name: "list_tabs",
    description: "List every open Chrome tab with its window index, tab index, URL, and title. Read-only. Use it to find the tab to operate on.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "inspect_form",
    description:
      "Inventory the form controls on a tab: every input, textarea, and select with its selector, label, type, required flag, and current value. Read-only. Call this before filling so selectors are real rather than guessed.",
    inputSchema: {
      type: "object",
      properties: {
        urlContains: { type: "string", description: "Substring matching the target tab's URL." },
      },
      required: ["urlContains"],
    },
  },
  {
    name: "fill_field",
    description:
      "Set the value of one input/textarea/select, using the native value setter plus input+change events so React and other controlled components register the change. Filling is reversible and does not submit anything.",
    inputSchema: {
      type: "object",
      properties: {
        urlContains: { type: "string", description: "Substring matching the target tab's URL." },
        selector: { type: "string", description: "CSS selector for the field, from inspect_form." },
        value: { type: "string", description: "Exact value to set." },
      },
      required: ["urlContains", "selector", "value"],
    },
  },
  {
    name: "click",
    description:
      "Click an element by CSS selector. REFUSES submit-like controls (type=submit, or text matching submit/save/confirm/send/post) unless allowSubmit is true, because submitting is an irreversible external side effect. Use it for tabs, expanders, and navigation.",
    inputSchema: {
      type: "object",
      properties: {
        urlContains: { type: "string", description: "Substring matching the target tab's URL." },
        selector: { type: "string", description: "CSS selector for the element." },
        allowSubmit: {
          type: "boolean",
          default: false,
          description: "Set true ONLY when the user has explicitly confirmed they want to submit.",
        },
      },
      required: ["urlContains", "selector"],
    },
  },
  {
    name: "read_text",
    description: "Return the visible text of the page or of one element. Read-only. Use it to confirm what a form looks like after filling.",
    inputSchema: {
      type: "object",
      properties: {
        urlContains: { type: "string", description: "Substring matching the target tab's URL." },
        selector: { type: "string", description: "Optional CSS selector; defaults to document.body." },
        limit: { type: "integer", minimum: 1, maximum: 20000, default: 4000, description: "Max characters to return." },
      },
      required: ["urlContains"],
    },
  },
];

// --- AppleScript plumbing -------------------------------------------------

async function osa(script, args = []) {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script, "--", ...args], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.replace(/\r?\n$/, "");
}

// NB: inside `tell application "Google Chrome"`, the word `tab` resolves to Chrome's
// tab class, so it cannot double as the tab-character constant. Use an explicit
// separator string instead.
// `tell application appName` with a VARIABLE cannot load Chrome's dictionary at
// compile time, so terms like `tab` would parse as unknown identifiers. Wrapping in
// `using terms from` (literal name) supplies the terminology while the tell block
// still targets whatever CHROME_APP points at.
const listTabsScript = String.raw`on run argv
  set appName to item 1 of argv
  set sep to "<|>"
  using terms from application "Google Chrome"
    tell application appName
      set out to ""
      repeat with wi from 1 to count of windows
        repeat with ti from 1 to count of tabs of window wi
          set theTab to tab ti of window wi
          set out to out & wi & sep & ti & sep & (URL of theTab) & sep & (title of theTab) & linefeed
        end repeat
      end repeat
      return out
    end tell
  end using terms from
end run`;

// Chrome's `execute javascript` returns the expression's value. We always return a
// JSON string from the injected snippet so the result survives the AppleScript hop.
const execJsScript = String.raw`on run argv
  set appName to item 1 of argv
  set needle to item 2 of argv
  set js to item 3 of argv
  using terms from application "Google Chrome"
    tell application appName
      repeat with wi from 1 to count of windows
        repeat with ti from 1 to count of tabs of window wi
          if (URL of tab ti of window wi) contains needle then
            return (execute tab ti of window wi javascript js)
          end if
        end repeat
      end repeat
    end tell
  end using terms from
  error "no Chrome tab whose URL contains " & needle
end run`;

async function runJs(urlContains, js) {
  const done = log.time("runJs", { urlContains, js });
  try {
    const raw = await osa(execJsScript, [CHROME_APP, urlContains, js]);
    done({ ok: true, raw });
    return raw;
  } catch (error) {
    const text = errorText(error);
    if (/-2700|Executing JavaScript through AppleScript is turned off/i.test(text)) {
      // The single most common setup failure: Chrome > View > Developer > Allow
      // JavaScript from Apple Events is off. Flag it distinctly so it stands out
      // in the logs instead of blending into generic errors.
      log.warn("runJs.chromeBlockingAppleEvents", { urlContains, text });
      done({ ok: false, blocked: true });
      throw new Error(
        "Chrome is blocking JavaScript from Apple Events. Enable it: Chrome > View > Developer > Allow JavaScript from Apple Events.",
      );
    }
    if (/no Chrome tab whose URL contains/i.test(text)) {
      log.error("runJs.tabNotFound", { urlContains, text });
    } else {
      log.error("runJs.error", { urlContains, text });
    }
    done({ ok: false, error: text });
    throw new Error(text);
  }
}

function errorText(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  return stderr || error?.message || String(error);
}

// --- injected snippets ----------------------------------------------------

// Build a stable-ish selector for a control, preferring id, then name.
const SELECTOR_HELPER = `
function sel(el) {
  if (el.id) return '#' + CSS.escape(el.id);
  // Only use [name=] when it is actually unique. Radio groups share one name, so
  // emitting it would make every option resolve to the first radio.
  if (el.name) {
    var byName = el.tagName.toLowerCase() + '[name="' + el.name + '"]';
    if (document.querySelectorAll(byName).length === 1) return byName;
  }
  // Build a full ancestor path. A bare 'input:nth-of-type(N)' is WRONG: nth-of-type
  // counts among siblings under one parent, not across the document, so a
  // document-order index produces a selector that matches the wrong element (or
  // nothing). Walk up and emit a nth-of-type step per level instead.
  var parts = [];
  var node = el;
  while (node && node.nodeType === 1 && node !== document.body) {
    var idx = 1;
    var sib = node;
    while ((sib = sib.previousElementSibling)) {
      if (sib.tagName === node.tagName) idx++;
    }
    parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + idx + ')');
    node = node.parentElement;
  }
  var path = 'body > ' + parts.join(' > ');
  // Verify it actually resolves back to this element before handing it out.
  try {
    if (document.querySelector(path) === el) return path;
  } catch (e) {}
  return path;
}
function labelFor(el) {
  if (el.labels && el.labels.length) return el.labels[0].innerText.trim();
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
  if (el.placeholder) return el.placeholder;
  var prev = el.previousElementSibling;
  if (prev && prev.innerText) return prev.innerText.trim().slice(0, 120);
  return '';
}`;

const inspectJs = `(function(){${SELECTOR_HELPER}
  var out = [];
  document.querySelectorAll('input, textarea, select').forEach(function(el){
    if (el.type === 'hidden') return;
    out.push({
      selector: sel(el),
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      label: labelFor(el),
      required: !!el.required,
      maxLength: el.maxLength > 0 ? el.maxLength : undefined,
      value: (el.value || '').slice(0, 300)
    });
  });
  var buttons = [];
  document.querySelectorAll('button, [role=button], input[type=submit]').forEach(function(el){
    buttons.push({ selector: sel(el), text: (el.innerText || el.value || '').trim().slice(0, 80), type: el.type || '' });
  });
  return JSON.stringify({ url: location.href, title: document.title, fields: out, buttons: buttons }, null, 2);
})()`;

// React (and Vue) track value on the DOM node; assigning .value directly bypasses
// their change detection. Use the prototype's native setter, then fire the events
// the framework listens for.
const fillJs = (selector, value) => `(function(){
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return JSON.stringify({ ok:false, error:'no element for selector' });
  var v = ${JSON.stringify(value)};
  var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
            : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
  var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  el.focus();
  setter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();
  return JSON.stringify({ ok:true, selector:${JSON.stringify(selector)}, valueNow: el.value.slice(0,300) });
})()`;

const SUBMITTY = /\b(submit|save|confirm|send|post|publish|finish)\b/i;

const clickJs = (selector, allowSubmit) => `(function(){
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return JSON.stringify({ ok:false, error:'no element for selector' });
  var text = (el.innerText || el.value || '').trim();
  var looksSubmit = el.type === 'submit' || ${SUBMITTY}.test(text);
  if (looksSubmit && !${allowSubmit ? "true" : "false"}) {
    return JSON.stringify({ ok:false, refused:true, reason:'element looks like a submit control', text:text });
  }
  el.click();
  return JSON.stringify({ ok:true, clicked:text || ${JSON.stringify(selector)} });
})()`;

const readTextJs = (selector, limit) => `(function(){
  var el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.body"};
  if (!el) return JSON.stringify({ ok:false, error:'no element for selector' });
  return JSON.stringify({ ok:true, text: (el.innerText || '').slice(0, ${limit}) });
})()`;

// --- tool dispatch --------------------------------------------------------

async function callTool(id, name, args = {}) {
  const done = log.time("tool.call", { name, args });
  try {
    if (name === "list_tabs") {
      const raw = await osa(listTabsScript, [CHROME_APP]);
      const tabs = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [w, t, url, title] = line.split("<|>");
          return { window: Number(w), tab: Number(t), url, title };
        });
      done({ ok: true, tabCount: tabs.length });
      return toolResult(id, JSON.stringify({ tabs }, null, 2));
    }

    const urlContains = args.urlContains;
    if (typeof urlContains !== "string" || !urlContains.trim()) {
      throw new Error("urlContains must be a non-empty string");
    }

    if (name === "inspect_form") {
      const out = await runJs(urlContains, inspectJs);
      try {
        const parsed = JSON.parse(out || "{}");
        log.debug("inspect_form.result", {
          fieldCount: parsed.fields?.length ?? 0,
          buttonCount: parsed.buttons?.length ?? 0,
        });
      } catch (parseError) {
        log.error("inspect_form.parseError", parseError);
      }
      done({ ok: true });
      return toolResult(id, out);
    }

    if (name === "fill_field") {
      if (typeof args.selector !== "string" || !args.selector.trim()) {
        throw new Error("selector must be a non-empty string");
      }
      if (typeof args.value !== "string") throw new Error("value must be a string");
      const out = await runJs(urlContains, fillJs(args.selector, args.value));
      const parsed = JSON.parse(out || "{}");
      // React ignores naive value assignment. If valueNow doesn't match value, the
      // write silently did not take — this is exactly the bug class to watch for.
      log.debug("fill_field.result", {
        selector: args.selector,
        value: args.value,
        valueNow: parsed.valueNow,
        matched: parsed.valueNow === args.value,
        ok: parsed.ok,
      });
      if (!parsed.ok) throw new Error(parsed.error || "fill failed");
      done({ ok: true });
      return toolResult(id, out);
    }

    if (name === "click") {
      if (typeof args.selector !== "string" || !args.selector.trim()) {
        throw new Error("selector must be a non-empty string");
      }
      const out = await runJs(urlContains, clickJs(args.selector, args.allowSubmit === true));
      const parsed = JSON.parse(out || "{}");
      if (parsed.refused) {
        // Refusals must be obvious: this adapter must never submit a form
        // unintentionally, so log this distinctly at warn with refused:true.
        log.warn("click.refused", { selector: args.selector, text: parsed.text, refused: true });
        done({ ok: false, refused: true });
        return toolResult(
          id,
          `refused: "${parsed.text}" looks like a submit control. Re-call with allowSubmit:true only after the user explicitly confirms.`,
          true,
        );
      }
      log.debug("click.result", { selector: args.selector, text: parsed.clicked, refused: false, ok: parsed.ok });
      if (!parsed.ok) throw new Error(parsed.error || "click failed");
      done({ ok: true });
      return toolResult(id, out);
    }

    if (name === "read_text") {
      const limit = args.limit ?? 4000;
      const out = await runJs(urlContains, readTextJs(args.selector, limit));
      done({ ok: true });
      return toolResult(id, out);
    }

    done({ ok: false, error: "unknown tool" });
    return toolResult(id, `unknown tool: ${name}`, true);
  } catch (error) {
    log.error("tool.call.error", error);
    done({ ok: false, error: errorText(error) });
    return toolResult(id, `${name || "tool"} failed: ${errorText(error)}`, true);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    log.warn("rpc.parseError", { line, error: errorText(error) });
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    log.debug("rpc.initialize", { params });
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "chrome-mcp", version: "0.1.0" },
      },
    });
  } else if (method === "tools/list") {
    log.debug("rpc.tools_list", {});
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    void callTool(id, params?.name, params?.arguments);
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} });
  }
});
