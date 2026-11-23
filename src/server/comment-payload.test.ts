import { describe, expect, it } from 'vitest';

import { parseBaseVersion, parseCommentsPayload, toCommentThread } from './comment-payload.js';

describe('parseCommentsPayload', () => {
  it('converts CommentThread-shaped threads and toCommentThread converts them back', () => {
    const [thread] = parseCommentsPayload({
      threads: [
        {
          id: 't1',
          file: 'src/a.ts',
          line: [3, 5],
          side: 'old',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
          codeContent: 'const a = 1;',
          messages: [
            { id: '', body: 'first', createdAt: '2024-01-01T00:00:00Z', updatedAt: '' },
            {
              id: 'm2',
              body: 'second',
              author: 'bot',
              createdAt: '2024-01-02T00:00:00Z',
              updatedAt: '2024-01-02T00:00:00Z',
            },
          ],
        },
      ],
    });

    expect(thread).toEqual({
      id: 't1',
      filePath: 'src/a.ts',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      position: { side: 'old', line: { start: 3, end: 5 } },
      codeSnapshot: { content: 'const a = 1;' },
      messages: [
        {
          id: 't1:0',
          body: 'first',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'm2',
          body: 'second',
          author: 'bot',
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      ],
    });

    expect(toCommentThread(thread!)).toMatchObject({
      id: 't1',
      file: 'src/a.ts',
      line: [3, 5],
      side: 'old',
      codeContent: 'const a = 1;',
    });
  });

  it('fills a placeholder file and message for a CommentThread without them', () => {
    const [thread] = parseCommentsPayload({
      threads: [
        {
          id: 't1',
          line: 4,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          messages: [],
        },
      ],
    });

    expect(thread).toMatchObject({
      filePath: '<unknown file>',
      position: { side: 'new', line: 4 },
      messages: [
        {
          id: 't1',
          body: '',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
    });
  });

  it.each([
    [7, 7],
    [[2, 2], { start: 2, end: 2 }],
    [0, 1],
    [-3, 1],
    [1.5, 1],
    [[5, 3], 1],
    [[0, 2], 1],
    [[1], 1],
    ['10', 1],
  ])('normalizes comment line %j to %j', (line, expected) => {
    const [thread] = parseCommentsPayload({
      comments: [{ id: 'c1', file: 'a.ts', line, body: 'x', timestamp: '2024-01-01T00:00:00Z' }],
    });

    expect(thread?.position.line).toEqual(expected);
  });

  it('returns no threads when the payload has neither threads nor comments', () => {
    expect(parseCommentsPayload({})).toEqual([]);
  });
});

describe('parseBaseVersion', () => {
  it.each([
    [{ baseVersion: 0 }, 0],
    [{ baseVersion: 3 }, 3],
    [{ baseVersion: -1 }, undefined],
    [{ baseVersion: 1.5 }, undefined],
    [{ baseVersion: '2' }, undefined],
    [{}, undefined],
    [null, undefined],
    ['{"baseVersion":2}', undefined],
  ])('reads %j as %j', (payload, expected) => {
    expect(parseBaseVersion(payload)).toBe(expected);
  });
});
