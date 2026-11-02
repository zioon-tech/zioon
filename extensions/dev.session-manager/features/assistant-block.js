import {
  findAssistantBlockEndOffset,
  findAssistantBlockEndOffsetById
} from "../../../src/chat/restore";

export function findAssistantBlockEndInText(text, hintPos) {
  return findAssistantBlockEndOffset(text, hintPos);
}

export function findAssistantBlockEndInTextById(text, assistantBlockId) {
  return findAssistantBlockEndOffsetById(text, assistantBlockId);
}
