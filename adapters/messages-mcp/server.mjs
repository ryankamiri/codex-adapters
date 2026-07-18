#!/usr/bin/env node
// messages-mcp — constrained AppleScript tools for macOS Messages.
// stdout is reserved for newline-delimited JSON-RPC; diagnostics go to stderr.

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const toolResult = (id, text, isError = false) =>
  send({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
  });

const ARTIFACTS_DIR = path.resolve(process.env.ARTIFACTS_DIR || process.cwd());
const FIELD_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";

const TOOLS = [
  {
    name: "observe_messages",
    description:
      "Read the configured Messages services and a summary of recent chats. This is read-only; use it to inspect availability or identify a chat before sending.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Maximum number of chats to return (default 20).",
        },
      },
    },
  },
  {
    name: "find_chats",
    description:
      "Find existing Messages chats by chat name, participant name, handle, or exact chat ID. This is read-only. Results include participant details so the user can disambiguate a group before sending.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive chat name, participant name/handle, or exact chat ID." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "search_contacts",
    description:
      "Search macOS Contacts by name and return matching phone numbers and email addresses. This is read-only and may prompt for Contacts permission.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive text to match against a contact's full name." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "send_message",
    description:
      "Send an iMessage or SMS through macOS Messages to an exact phone number or Apple ID/email. This creates an external side effect: call it only after the user has supplied or confirmed both the exact recipient and exact message text. It sends immediately and cannot be recalled by this tool.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: {
          type: "string",
          description: "Exact phone number (prefer E.164, such as +15551234567) or Apple ID/email.",
        },
        message: { type: "string", description: "Exact text to send." },
        service: {
          type: "string",
          enum: ["auto", "iMessage", "SMS"],
          default: "auto",
          description: "Preferred service. Auto tries available services in Messages order.",
        },
      },
      required: ["recipient", "message"],
    },
  },
  {
    name: "send_to_chat",
    description:
      "Send text to an existing one-to-one or group chat using its exact chat ID. This sends immediately and cannot be recalled. Call it only after the user has confirmed the exact chat (including participants when needed) and exact message text.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Exact stable chat ID returned by find_chats or observe_messages." },
        message: { type: "string", description: "Exact text to send." },
      },
      required: ["chat_id", "message"],
    },
  },
  {
    name: "capture_chats",
    description:
      "Capture a read-only snapshot of Messages service and chat metadata as a JSON artifact. Message bodies are not included. Use it when another tool or later step needs a file.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          default: 100,
          description: "Maximum number of chats to capture (default 100).",
        },
      },
    },
  },
];

const observeScript = String.raw`on run argv
  set maxChats to (item 1 of argv) as integer
  set fieldSeparator to ASCII character 31
  set recordSeparator to ASCII character 30
  set output to ""
  tell application "Messages"
    repeat with currentService in services
      try
        set output to output & "service" & fieldSeparator & (name of currentService as text) & fieldSeparator & (service type of currentService as text) & recordSeparator
      end try
    end repeat
    set chatCount to count of chats
    if chatCount > maxChats then set chatCount to maxChats
    repeat with chatIndex from 1 to chatCount
      set currentChat to item chatIndex of chats
      set chatId to ""
      set chatName to ""
      try
        set chatId to id of currentChat as text
      end try
      try
        set chatName to name of currentChat as text
      end try
      set output to output & "chat" & fieldSeparator & chatId & fieldSeparator & chatName & recordSeparator
    end repeat
  end tell
  return output
end run`;

const findChatsScript = String.raw`on run argv
  set searchText to item 1 of argv
  set maxChats to (item 2 of argv) as integer
  set fieldSeparator to item 3 of argv
  set recordSeparator to item 4 of argv
  set output to ""
  set matchCount to 0
  using terms from application "Messages"
  tell application "Messages"
    set matchingChats to chats
    repeat with currentChat in matchingChats
      if matchCount is greater than or equal to maxChats then exit repeat
      set chatId to ""
      set chatName to ""
      set participantText to ""
      try
        set chatId to id of currentChat as text
      end try
      try
        set chatName to name of currentChat as text
      end try
      try
        repeat with currentParticipant in (get participants of currentChat)
          set participantName to ""
          set participantHandle to ""
          try
            set participantName to (get name of currentParticipant) as text
          end try
          try
            set participantHandle to (get handle of currentParticipant) as text
          end try
          if participantText is not "" then set participantText to participantText & fieldSeparator
          set participantText to participantText & participantName & fieldSeparator & participantHandle
        end repeat
      end try
      ignoring case
        if chatId contains searchText or chatName contains searchText or participantText contains searchText then
          set output to output & chatId & fieldSeparator & chatName & fieldSeparator & participantText & recordSeparator
          set matchCount to matchCount + 1
        end if
      end ignoring
    end repeat
  end tell
  end using terms from
  return output
end run`;

const contactsScript = String.raw`on run argv
  set searchText to item 1 of argv
  set maxContacts to (item 2 of argv) as integer
  set fieldSeparator to item 3 of argv
  set recordSeparator to item 4 of argv
  set output to ""
  set matchCount to 0
  using terms from application "Contacts"
  tell application "Contacts"
    repeat with currentPerson in (get every person)
      if matchCount is greater than or equal to maxContacts then exit repeat
      set personName to name of currentPerson as text
      ignoring case
        set isMatch to personName contains searchText
      end ignoring
      if isMatch then
        set phonesText to ""
        set emailsText to ""
        repeat with currentPhone in phones of currentPerson
          if phonesText is not "" then set phonesText to phonesText & "|"
          set phonesText to phonesText & (value of currentPhone as text)
        end repeat
        repeat with currentEmail in emails of currentPerson
          if emailsText is not "" then set emailsText to emailsText & "|"
          set emailsText to emailsText & (value of currentEmail as text)
        end repeat
        set output to output & personName & fieldSeparator & phonesText & fieldSeparator & emailsText & recordSeparator
        set matchCount to matchCount + 1
      end if
    end repeat
  end tell
  end using terms from
  return output
end run`;

const sendScript = String.raw`on run argv
  set recipientAddress to item 1 of argv
  set messageText to item 2 of argv
  set requestedService to item 3 of argv
  tell application "Messages"
    set matchingServices to services
    repeat with currentService in matchingServices
      set currentType to ""
      try
        set currentType to service type of currentService as text
      end try
      if requestedService is "auto" or currentType is requestedService then
        try
          set targetBuddy to buddy recipientAddress of currentService
          send messageText to targetBuddy
          return currentType
        end try
      end if
    end repeat
  end tell
  error "No usable Messages service found for recipient " & recipientAddress
end run`;

const sendToChatScript = String.raw`on run argv
  set requestedChatId to item 1 of argv
  set messageText to item 2 of argv
  using terms from application "Messages"
  tell application "Messages"
    set matchingChats to chats
    repeat with currentChat in matchingChats
      try
        if (id of currentChat as text) is requestedChatId then
          send messageText to currentChat
          return requestedChatId
        end if
      end try
    end repeat
  end tell
  end using terms from
  error "No Messages chat found with ID " & requestedChatId
end run`;

function validateLimit(value, fallback, maximum) {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`limit must be an integer between 1 and ${maximum}`);
  }
  return limit;
}

function parseObservation(output) {
  const services = [];
  const chats = [];
  for (const record of output.split(RECORD_SEPARATOR)) {
    if (!record) continue;
    const [kind, first = "", second = ""] = record.split(FIELD_SEPARATOR);
    if (kind === "service") services.push({ name: first, type: second });
    if (kind === "chat") chats.push({ id: first, name: second });
  }
  return { services, chats };
}

function parseChatMatches(output) {
  return output.split(RECORD_SEPARATOR).filter(Boolean).map((record) => {
    const [id = "", name = "", ...participantFields] = record.split(FIELD_SEPARATOR);
    const participants = [];
    for (let index = 0; index < participantFields.length; index += 2) {
      const participantName = participantFields[index] || "";
      const handle = participantFields[index + 1] || "";
      if (participantName || handle) participants.push({ name: participantName, handle });
    }
    return { id, name, participants };
  });
}

function parseContacts(output) {
  return output.split(RECORD_SEPARATOR).filter(Boolean).map((record) => {
    const [name = "", phones = "", emails = ""] = record.split(FIELD_SEPARATOR);
    return { name, phones: phones ? phones.split("|") : [], emails: emails ? emails.split("|") : [] };
  });
}

function validateQuery(value, label = "query") {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

async function runAppleScript(script, args = []) {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script, "--", ...args], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.replace(/\r?\n$/, "");
}

function errorText(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  return stderr || error?.message || String(error);
}

async function callTool(id, name, args = {}) {
  try {
    if (name === "observe_messages" || name === "capture_chats") {
      const maximum = name === "capture_chats" ? 500 : 100;
      const fallback = name === "capture_chats" ? 100 : 20;
      const limit = validateLimit(args.limit, fallback, maximum);
      const snapshot = parseObservation(await runAppleScript(observeScript, [String(limit)]));
      const json = JSON.stringify(snapshot, null, 2);
      if (name === "observe_messages") return toolResult(id, json);

      fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
      const artifact = path.join(ARTIFACTS_DIR, "messages-chats.json");
      fs.writeFileSync(artifact, `${json}\n`, { encoding: "utf8", mode: 0o600 });
      return toolResult(id, `wrote ${artifact}`);
    }

    if (name === "find_chats") {
      const query = validateQuery(args.query);
      const limit = validateLimit(args.limit, 20, 100);
      const matches = parseChatMatches(await runAppleScript(findChatsScript, [query, String(limit), FIELD_SEPARATOR, RECORD_SEPARATOR]));
      return toolResult(id, JSON.stringify({ query, matches }, null, 2));
    }

    if (name === "search_contacts") {
      const query = validateQuery(args.query);
      const limit = validateLimit(args.limit, 20, 100);
      const contacts = parseContacts(await runAppleScript(contactsScript, [query, String(limit), FIELD_SEPARATOR, RECORD_SEPARATOR]));
      return toolResult(id, JSON.stringify({ query, contacts }, null, 2));
    }

    if (name === "send_message") {
      if (typeof args.recipient !== "string" || args.recipient.trim() === "") {
        throw new Error("recipient must be a non-empty string");
      }
      if (typeof args.message !== "string" || args.message.trim() === "") {
        throw new Error("message must be a non-empty string");
      }
      const service = args.service ?? "auto";
      if (!["auto", "iMessage", "SMS"].includes(service)) {
        throw new Error("service must be auto, iMessage, or SMS");
      }
      const usedService = await runAppleScript(sendScript, [args.recipient.trim(), args.message, service]);
      return toolResult(id, JSON.stringify({ sent: true, recipient: args.recipient.trim(), service: usedService }));
    }

    if (name === "send_to_chat") {
      const chatId = validateQuery(args.chat_id, "chat_id");
      const message = validateQuery(args.message, "message");
      await runAppleScript(sendToChatScript, [chatId, message]);
      return toolResult(id, JSON.stringify({ sent: true, chat_id: chatId }));
    }

    return toolResult(id, `unknown tool: ${name}`, true);
  } catch (error) {
    return toolResult(id, `${name || "tool"} failed: ${errorText(error)}`, true);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = message;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "messages-mcp", version: "0.1.0" },
      },
    });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    void callTool(id, params?.name, params?.arguments);
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} });
  }
});
