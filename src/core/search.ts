import type { MessageSearchHit } from '../storage/repositories.js';

/**
 * Local, case-insensitive substring search across conversations and cached
 * messages. Runs against data we already hold (adapter conversation lists
 * and the SQLite cache) so it needs no network and no native adapter
 * support - `capabilities.canSearch` stays reserved for platform-side
 * search APIs.
 */

export interface ConversationHit {
  type: 'conversation';
  accountId: string;
  conversationId: string;
  title: string;
}

export interface MessageHit {
  type: 'message';
  accountId: string;
  conversationId: string;
  conversationTitle: string;
  snippet: string;
  timestamp: number;
}

export type SearchHit = ConversationHit | MessageHit;

export interface SearchInput {
  conversations: Array<{ accountId: string; id: string; title: string }>;
  messageHits: MessageSearchHit[];
}

const SNIPPET_RADIUS = 24;

export function searchAll(input: SearchInput, query: string, limit = 20): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];

  const hits: SearchHit[] = [];
  for (const c of input.conversations) {
    if (c.title.toLowerCase().includes(q)) {
      hits.push({ type: 'conversation', accountId: c.accountId, conversationId: c.id, title: c.title });
    }
  }
  for (const hit of input.messageHits) {
    const text = hit.message.text;
    const at = text.toLowerCase().indexOf(q);
    if (at === -1) continue;
    const start = Math.max(0, at - SNIPPET_RADIUS);
    const end = Math.min(text.length, at + q.length + SNIPPET_RADIUS);
    hits.push({
      type: 'message',
      accountId: hit.accountId,
      conversationId: hit.conversationId,
      conversationTitle: hit.conversationTitle,
      snippet: text.slice(start, end).replace(/\s+/g, ' ').trim(),
      timestamp: hit.message.timestamp,
    });
  }
  // Conversations first (they are "jump targets"), then messages, recent first.
  hits.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'conversation' ? -1 : 1;
    if (a.type === 'message' && b.type === 'message') return b.timestamp - a.timestamp;
    return 0;
  });
  return hits.slice(0, limit);
}
