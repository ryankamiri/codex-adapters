"use client";

// Middle column: the conversation itself, kept deliberately clean like ChatGPT.
// Only text + reasoning parts render here — every tool call, command, file change
// and snapshot is routed to the WorkspacePanel on the right. When the thread is
// empty we center the composer under a greeting; once it has messages the composer
// drops to the bottom. The composer footer holds the model picker (GPT-style
// inline dropdown) and the submit/stop button.

import type { UIMessage } from "ai";
import type { ChatStatus } from "ai";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "@/components/ai-elements/reasoning";
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputSubmit,
  PromptInputSelect,
  PromptInputSelectTrigger,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectValue,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import type { ModelInfo } from "@/lib/models";

interface ChatPaneProps {
  messages: UIMessage[];
  status: ChatStatus;
  onSend: (text: string) => void;
  onStop: () => void;
  models: ModelInfo[];
  model: string | null;
  setModel: (id: string) => void;
}

export function ChatPane({ messages, status, onSend, onStop, models, model, setModel }: ChatPaneProps) {
  const empty = messages.length === 0;

  // Label shown on the trigger: the selected model's display name, falling back to
  // the raw id (before the list loads) so it never renders blank.
  const modelLabel = models.find((m) => m.id === model)?.displayName ?? model ?? undefined;

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text?.trim();
    if (!text) return;
    onSend(text);
  };

  const composer = (
    <PromptInput onSubmit={handleSubmit} className="w-full">
      <PromptInputBody>
        <PromptInputTextarea placeholder="Ask anything" />
      </PromptInputBody>
      <PromptInputFooter>
        {/* left side (attachments etc.) — empty for now so the model picker sits
            on the right next to the submit button, ChatGPT-style. */}
        <PromptInputTools />
        <div className="flex items-center gap-1">
          {model !== null && (
            <PromptInputSelect
              value={model}
              onValueChange={(value) => setModel(String(value))}
            >
              <PromptInputSelectTrigger>
                <PromptInputSelectValue placeholder="Model">{modelLabel}</PromptInputSelectValue>
              </PromptInputSelectTrigger>
              <PromptInputSelectContent align="end">
                {models.map((m) => (
                  <PromptInputSelectItem key={m.id} value={m.id}>
                    {m.displayName}
                  </PromptInputSelectItem>
                ))}
              </PromptInputSelectContent>
            </PromptInputSelect>
          )}
          <PromptInputSubmit status={status} onStop={onStop} />
        </div>
      </PromptInputFooter>
    </PromptInput>
  );

  if (empty) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-8 px-4">
        <h1 className="text-center text-2xl font-medium text-foreground">Where should we begin?</h1>
        <div className="w-full max-w-3xl">{composer}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.map((message) => {
            const isLast = message === messages.at(-1);
            const streaming = status === "streaming" && isLast;
            return (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.parts.map((part, i) => {
                    const key = `${message.id}-${i}`;
                    if (part.type === "text") {
                      return <MessageResponse key={key}>{part.text}</MessageResponse>;
                    }
                    if (part.type === "reasoning") {
                      return (
                        <Reasoning
                          key={key}
                          isStreaming={streaming && i === message.parts.length - 1}
                        >
                          <ReasoningTrigger />
                          <ReasoningContent>{part.text}</ReasoningContent>
                        </Reasoning>
                      );
                    }
                    return null;
                  })}
                </MessageContent>
              </Message>
            );
          })}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">{composer}</div>
    </div>
  );
}
