import { describe, expect, it } from 'vitest';
import { searchAll } from './search.js';

const INPUT = {
  conversations: [
    { accountId: 'wa-a', id: 'fam', title: 'Family group' },
    { accountId: 'slack', id: 'general', title: '#general' },
  ],
  messageHits: [
    {
      accountId: 'wa-a',
      conversationId: 'fam',
      conversationTitle: 'Family group',
      message: {
        id: 'm1',
        accountId: 'wa-a',
        conversationId: 'fam',
        direction: 'incoming' as const,
        text: 'Dinner at 7? Bring the good bread',
        timestamp: 1000,
      },
    },
    {
      accountId: 'slack',
      conversationId: 'general',
      conversationTitle: '#general',
      message: {
        id: 'm2',
        accountId: 'slack',
        conversationId: 'general',
        direction: 'incoming' as const,
        text: 'Reminder: submit timesheets',
        timestamp: 2000,
      },
    },
  ],
};

describe('searchAll', () => {
  it('returns nothing for empty queries', () => {
    expect(searchAll(INPUT, '   ')).toEqual([]);
  });

  it('matches conversation titles case-insensitively, ranked before messages', () => {
    const hits = searchAll(INPUT, 'family');
    expect(hits[0]).toMatchObject({ type: 'conversation', conversationId: 'fam' });
  });

  it('matches cached message text with a snippet', () => {
    const hits = searchAll(INPUT, 'bread');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ type: 'message', conversationTitle: 'Family group' });
    if (hits[0].type === 'message') {
      expect(hits[0].snippet).toContain('bread');
    }
  });

  it('orders message hits newest first', () => {
    const hits = searchAll(INPUT, 're');
    const messages = hits.filter((h) => h.type === 'message');
    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1];
      const curr = messages[i];
      if (prev.type === 'message' && curr.type === 'message') {
        expect(prev.timestamp).toBeGreaterThanOrEqual(curr.timestamp);
      }
    }
  });

  it('collapses whitespace in snippets', () => {
    const input = {
      conversations: [],
      messageHits: [
        {
          ...INPUT.messageHits[0],
          message: { ...INPUT.messageHits[0].message, text: 'line\n  with    space' },
        },
      ],
    };
    const hits = searchAll(input, 'with');
    expect(hits[0]).toMatchObject({ type: 'message', snippet: 'line with space' });
  });
});
