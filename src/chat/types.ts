export type ChatRole = "system" | "user" | "assistant" | "tool" | string;

export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImageUrlPart {
  type: "image_url";
  image_url: {
    url: string;
  };
}

export type ChatMessagePart = ChatTextPart | ChatImageUrlPart | Record<string, unknown>;

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatMessagePart[];
}

export interface AssistantAnchor {
  sessionId: string;
  headLine: number;
  anchorPos: number;
}

export interface ChatDocInsertResult {
  anchor: AssistantAnchor | null;
  insertLine: number;
}
