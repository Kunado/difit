import { createHash } from 'crypto';

import {
  type Comment,
  type CommentImport,
  type CommentThread,
  type DiffCommentThread,
} from '../types/diff.js';
import { normalizeCommentImports } from '../utils/commentImports.js';

function normalizeLineValue(line: unknown): DiffCommentThread['position']['line'] {
  if (Array.isArray(line) && line.length === 2) {
    const start = line[0] as unknown;
    const end = line[1] as unknown;
    if (
      typeof start === 'number' &&
      typeof end === 'number' &&
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start > 0 &&
      end > 0 &&
      start <= end
    ) {
      return { start, end };
    }
  }

  if (typeof line === 'number' && Number.isInteger(line) && line > 0) {
    return line;
  }

  return 1;
}

function normalizeComment(comment: Comment): DiffCommentThread {
  const now = new Date().toISOString();
  const timestamp = typeof comment.timestamp === 'string' ? comment.timestamp : now;
  const threadId =
    typeof comment.id === 'string' && comment.id.length > 0
      ? comment.id
      : createHash('sha256').update(JSON.stringify(comment)).digest('hex').slice(0, 12);
  const filePath =
    typeof comment.file === 'string' && comment.file.length > 0 ? comment.file : '<unknown file>';

  return {
    id: threadId,
    filePath,
    createdAt: timestamp,
    updatedAt: timestamp,
    position: {
      side: comment.side ?? 'new',
      line: normalizeLineValue(comment.line),
    },
    codeSnapshot:
      typeof comment.codeContent === 'string'
        ? {
            content: comment.codeContent,
          }
        : undefined,
    messages: [
      {
        id: threadId,
        body: comment.body,
        author: comment.author,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

export function toCommentThread(thread: DiffCommentThread): CommentThread {
  return {
    id: thread.id,
    file: thread.filePath,
    line:
      typeof thread.position.line === 'number'
        ? thread.position.line
        : ([thread.position.line.start, thread.position.line.end] as [number, number]),
    side: thread.position.side,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    codeContent: thread.codeSnapshot?.content,
    messages: thread.messages,
  };
}

function normalizeThreadPayload(thread: CommentThread | DiffCommentThread): DiffCommentThread {
  if ('filePath' in thread && 'position' in thread) {
    return thread;
  }

  const threadId =
    typeof thread.id === 'string' && thread.id.length > 0
      ? thread.id
      : createHash('sha256').update(JSON.stringify(thread)).digest('hex').slice(0, 12);
  const now = new Date().toISOString();
  const messages =
    Array.isArray(thread.messages) && thread.messages.length > 0
      ? thread.messages.map((message, index) => ({
          id:
            typeof message.id === 'string' && message.id.length > 0
              ? message.id
              : `${threadId}:${index}`,
          body: message.body,
          author: message.author,
          createdAt: message.createdAt || thread.createdAt || now,
          updatedAt: message.updatedAt || message.createdAt || thread.updatedAt || now,
        }))
      : [
          {
            id: threadId,
            body: '',
            createdAt: thread.createdAt || now,
            updatedAt: thread.updatedAt || thread.createdAt || now,
          },
        ];
  const firstMessage = messages[0];
  const lastMessage = messages[messages.length - 1];

  return {
    id: threadId,
    filePath:
      typeof thread.file === 'string' && thread.file.length > 0 ? thread.file : '<unknown file>',
    createdAt: thread.createdAt || firstMessage?.createdAt || now,
    updatedAt: thread.updatedAt || lastMessage?.updatedAt || thread.createdAt || now,
    position: {
      side: thread.side ?? 'new',
      line: normalizeLineValue(thread.line),
    },
    codeSnapshot:
      typeof thread.codeContent === 'string'
        ? {
            content: thread.codeContent,
          }
        : undefined,
    messages,
  };
}

export function parseCommentsPayload(body: unknown): DiffCommentThread[] {
  const payload =
    typeof body === 'string'
      ? (JSON.parse(body) as {
          comments?: Comment[];
          threads?: Array<CommentThread | DiffCommentThread>;
        })
      : (body as {
          comments?: Comment[];
          threads?: Array<CommentThread | DiffCommentThread>;
        });

  if (Array.isArray(payload.threads)) {
    return payload.threads.map(normalizeThreadPayload);
  }

  if (Array.isArray(payload.comments)) {
    return payload.comments.map(normalizeComment);
  }

  return [];
}

// Version the client based its push on (omitted by older clients).
export function parseBaseVersion(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as { baseVersion?: unknown }).baseVersion;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function parseCommentImportsPayload(body: unknown): CommentImport[] {
  if (typeof body === 'string') {
    return normalizeCommentImports(JSON.parse(body));
  }

  return normalizeCommentImports(body);
}
