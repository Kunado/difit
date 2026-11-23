import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getPrCommentImports,
  getPrPatch,
  getPrTitle,
  parseGitHubPrUrl,
  parsePrCommentImportsResponse,
} from './github';

const { ghMock } = vi.hoisted(() => ({ ghMock: vi.fn() }));

// Every gh run resolves through ghMock, whether the code awaits a promisified
// execFile or passes it a callback. Synchronous runs fail the test, so no test
// reaches the real gh. Named imports of a built-in resolve through `default`,
// so the mock replaces both.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('util');
  const execFile = Object.assign(
    (file: string, args: string[], options: object, callback: (...result: unknown[]) => void) => {
      ghMock(file, args, options).then(
        ({ stdout, stderr }: { stdout: string; stderr: string }) => callback(null, stdout, stderr),
        (error: unknown) => callback(error, '', ''),
      );
    },
    { [promisify.custom]: (...args: unknown[]) => ghMock(...args) },
  );
  const mocked = {
    ...actual,
    execFile,
    execFileSync: () => {
      throw new Error('gh must not run synchronously');
    },
  };
  return { ...mocked, default: mocked };
});

function createReviewComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'COMMENT_1',
    body: 'Imported comment',
    createdAt: '2026-03-25T09:00:00Z',
    updatedAt: '2026-03-25T09:05:00Z',
    author: { login: 'octocat' },
    ...overrides,
  };
}

function createReviewThread(overrides: Record<string, unknown> = {}) {
  return {
    id: 'THREAD_1',
    isResolved: false,
    isOutdated: false,
    subjectType: 'LINE',
    path: 'src/example.ts',
    diffSide: 'RIGHT',
    startDiffSide: null,
    line: 12,
    startLine: null,
    originalLine: 11,
    originalStartLine: null,
    comments: {
      nodes: [createReviewComment()],
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CLI GitHub utils', () => {
  describe('parsePrCommentImportsResponse', () => {
    it('imports unresolved inline threads, sorts comments, and skips non-importable threads', () => {
      const response = {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  createReviewThread({
                    id: 'THREAD_UNRESOLVED',
                    diffSide: 'RIGHT',
                    line: 14,
                    comments: {
                      nodes: [
                        createReviewComment({
                          id: 'COMMENT_REPLY',
                          body: 'Second comment',
                          createdAt: '2026-03-25T09:10:00Z',
                          updatedAt: '2026-03-25T09:12:00Z',
                          author: { login: 'reviewer-2' },
                        }),
                        createReviewComment({
                          id: 'COMMENT_ROOT',
                          body: 'First comment',
                          createdAt: '2026-03-25T09:00:00Z',
                          updatedAt: '2026-03-25T09:05:00Z',
                          author: { login: 'reviewer-1' },
                        }),
                      ],
                    },
                  }),
                  createReviewThread({
                    id: 'THREAD_RESOLVED',
                    isResolved: true,
                  }),
                  createReviewThread({
                    id: 'THREAD_OUTDATED',
                    isOutdated: true,
                  }),
                  createReviewThread({
                    id: 'THREAD_FILE',
                    subjectType: 'FILE',
                  }),
                ],
                pageInfo: {
                  hasNextPage: true,
                  endCursor: 'CURSOR_1',
                },
              },
            },
          },
        },
      };

      const result = parsePrCommentImportsResponse(response);

      expect(result).toEqual({
        commentImports: [
          {
            type: 'thread',
            id: 'COMMENT_ROOT',
            filePath: 'src/example.ts',
            position: { side: 'new', line: 14 },
            body: 'First comment',
            author: 'reviewer-1',
            createdAt: '2026-03-25T09:00:00Z',
            updatedAt: '2026-03-25T09:05:00Z',
          },
          {
            type: 'reply',
            id: 'COMMENT_REPLY',
            filePath: 'src/example.ts',
            position: { side: 'new', line: 14 },
            body: 'Second comment',
            author: 'reviewer-2',
            createdAt: '2026-03-25T09:10:00Z',
            updatedAt: '2026-03-25T09:12:00Z',
          },
        ],
        pageInfo: {
          hasNextPage: true,
          endCursor: 'CURSOR_1',
        },
      });
    });

    it('maps RIGHT and LEFT threads to new and old diff positions for single and multi-line comments', () => {
      const response = {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  createReviewThread({
                    id: 'THREAD_RIGHT_SINGLE',
                    diffSide: 'RIGHT',
                    line: 20,
                    startLine: 20,
                    startDiffSide: null,
                    comments: {
                      nodes: [createReviewComment({ id: 'COMMENT_RIGHT_SINGLE' })],
                    },
                  }),
                  createReviewThread({
                    id: 'THREAD_RIGHT_MULTI',
                    diffSide: 'RIGHT',
                    line: 24,
                    startLine: 21,
                    startDiffSide: 'RIGHT',
                    comments: {
                      nodes: [createReviewComment({ id: 'COMMENT_RIGHT_MULTI' })],
                    },
                  }),
                  createReviewThread({
                    id: 'THREAD_LEFT_SINGLE',
                    diffSide: 'LEFT',
                    line: null,
                    originalLine: 8,
                    originalStartLine: null,
                    startDiffSide: null,
                    comments: {
                      nodes: [createReviewComment({ id: 'COMMENT_LEFT_SINGLE' })],
                    },
                  }),
                  createReviewThread({
                    id: 'THREAD_LEFT_MULTI',
                    diffSide: 'LEFT',
                    line: null,
                    originalLine: 11,
                    originalStartLine: 7,
                    startDiffSide: 'LEFT',
                    comments: {
                      nodes: [createReviewComment({ id: 'COMMENT_LEFT_MULTI' })],
                    },
                  }),
                ],
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
              },
            },
          },
        },
      };

      const result = parsePrCommentImportsResponse(response);

      expect(result.commentImports).toEqual([
        {
          type: 'thread',
          id: 'COMMENT_RIGHT_SINGLE',
          filePath: 'src/example.ts',
          position: { side: 'new', line: 20 },
          body: 'Imported comment',
          author: 'octocat',
          createdAt: '2026-03-25T09:00:00Z',
          updatedAt: '2026-03-25T09:05:00Z',
        },
        {
          type: 'thread',
          id: 'COMMENT_RIGHT_MULTI',
          filePath: 'src/example.ts',
          position: { side: 'new', line: { start: 21, end: 24 } },
          body: 'Imported comment',
          author: 'octocat',
          createdAt: '2026-03-25T09:00:00Z',
          updatedAt: '2026-03-25T09:05:00Z',
        },
        {
          type: 'thread',
          id: 'COMMENT_LEFT_SINGLE',
          filePath: 'src/example.ts',
          position: { side: 'old', line: 8 },
          body: 'Imported comment',
          author: 'octocat',
          createdAt: '2026-03-25T09:00:00Z',
          updatedAt: '2026-03-25T09:05:00Z',
        },
        {
          type: 'thread',
          id: 'COMMENT_LEFT_MULTI',
          filePath: 'src/example.ts',
          position: { side: 'old', line: { start: 7, end: 11 } },
          body: 'Imported comment',
          author: 'octocat',
          createdAt: '2026-03-25T09:00:00Z',
          updatedAt: '2026-03-25T09:05:00Z',
        },
      ]);
    });

    it('warns and skips threads with invalid line mapping', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const response = {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  createReviewThread({
                    id: 'THREAD_RIGHT_MISSING_LINE',
                    diffSide: 'RIGHT',
                    line: null,
                  }),
                  createReviewThread({
                    id: 'THREAD_LEFT_MISSING_ORIGINAL',
                    diffSide: 'LEFT',
                    line: null,
                    originalLine: null,
                  }),
                  createReviewThread({
                    id: 'THREAD_RIGHT_BAD_RANGE',
                    diffSide: 'RIGHT',
                    line: 9,
                    startLine: 12,
                    startDiffSide: 'RIGHT',
                  }),
                  createReviewThread({
                    id: 'THREAD_LEFT_BAD_SIDE',
                    diffSide: 'LEFT',
                    line: null,
                    originalLine: 9,
                    originalStartLine: 7,
                    startDiffSide: 'RIGHT',
                  }),
                ],
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
              },
            },
          },
        },
      };

      const result = parsePrCommentImportsResponse(response);

      expect(result.commentImports).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(4);
      expect(warnSpy).toHaveBeenNthCalledWith(
        1,
        'Warning: Skipping PR review thread THREAD_RIGHT_MISSING_LINE: RIGHT thread is missing line.',
      );
      expect(warnSpy).toHaveBeenNthCalledWith(
        2,
        'Warning: Skipping PR review thread THREAD_LEFT_MISSING_ORIGINAL: LEFT thread is missing originalLine.',
      );
      expect(warnSpy).toHaveBeenNthCalledWith(
        3,
        'Warning: Skipping PR review thread THREAD_RIGHT_BAD_RANGE: RIGHT thread has an invalid multi-line range.',
      );
      expect(warnSpy).toHaveBeenNthCalledWith(
        4,
        'Warning: Skipping PR review thread THREAD_LEFT_BAD_SIDE: LEFT thread has mismatched startDiffSide.',
      );
    });
  });

  describe('parseGitHubPrUrl', () => {
    it('should parse valid GitHub PR URLs', () => {
      const result = parseGitHubPrUrl('https://github.com/owner/repo/pull/123');
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        pullNumber: 123,
        hostname: 'github.com',
      });
    });

    it('should parse GitHub PR URLs with additional path segments', () => {
      const result = parseGitHubPrUrl('https://github.com/owner/repo/pull/456/files');
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        pullNumber: 456,
        hostname: 'github.com',
      });
    });

    it('should parse GitHub PR URLs with query parameters', () => {
      const result = parseGitHubPrUrl('https://github.com/owner/repo/pull/789?tab=files');
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        pullNumber: 789,
        hostname: 'github.com',
      });
    });

    it('should handle URLs with hyphens and underscores in owner/repo names', () => {
      const result = parseGitHubPrUrl('https://github.com/owner-name/repo_name/pull/123');
      expect(result).toEqual({
        owner: 'owner-name',
        repo: 'repo_name',
        pullNumber: 123,
        hostname: 'github.com',
      });
    });

    it('should parse GitHub Enterprise PR URLs', () => {
      const result1 = parseGitHubPrUrl('https://github.enterprise.com/owner/repo/pull/123');
      expect(result1).toEqual({
        owner: 'owner',
        repo: 'repo',
        pullNumber: 123,
        hostname: 'github.enterprise.com',
      });

      const result2 = parseGitHubPrUrl('https://git.company.io/team/project/pull/456');
      expect(result2).toEqual({
        owner: 'team',
        repo: 'project',
        pullNumber: 456,
        hostname: 'git.company.io',
      });
    });

    it('should return null for invalid URLs', () => {
      expect(parseGitHubPrUrl('not-a-url')).toBe(null);
      expect(parseGitHubPrUrl('https://github.com/owner/repo/issues/123')).toBe(null);
      expect(parseGitHubPrUrl('https://github.com/owner/repo')).toBe(null);
      expect(parseGitHubPrUrl('https://github.com/owner/repo/pull/abc')).toBe(null);
    });

    it('should handle malformed URLs gracefully', () => {
      expect(parseGitHubPrUrl('')).toBe(null);
      expect(parseGitHubPrUrl('https://github.com')).toBe(null);
      expect(parseGitHubPrUrl('https://github.com/owner')).toBe(null);
      expect(parseGitHubPrUrl('https://github.com/owner/repo/pull')).toBe(null);
    });
  });

  describe('gh commands', () => {
    const PR_URL = 'https://github.com/owner/repo/pull/123';
    // Large PR patches exceed Node's 1 MiB default output buffer.
    const MAX_GH_OUTPUT_BYTES = 64 * 1024 * 1024;

    const reviewThreadsPage = (threadId: string, endCursor: string | null) => ({
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  createReviewThread({
                    id: threadId,
                    comments: { nodes: [createReviewComment({ id: `${threadId}_COMMENT` })] },
                  }),
                ],
                pageInfo: { hasNextPage: endCursor !== null, endCursor },
              },
            },
          },
        },
      }),
      stderr: '',
    });

    afterEach(() => {
      ghMock.mockReset();
    });

    it('runs gh pr diff without blocking, passing the URL after -- with a large buffer', async () => {
      let finish: (output: { stdout: string; stderr: string }) => void = () => {};
      ghMock.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );

      const patch = getPrPatch(PR_URL);
      let settled = false;
      void patch.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);

      finish({ stdout: 'diff --git a/x b/x\n', stderr: '' });
      await expect(patch).resolves.toBe('diff --git a/x b/x\n');
      expect(ghMock).toHaveBeenCalledWith(
        'gh',
        ['pr', 'diff', '--', PR_URL],
        expect.objectContaining({ encoding: 'utf8', maxBuffer: MAX_GH_OUTPUT_BYTES }),
      );
    });

    it('reports gh stderr with a login hint when gh pr diff fails', async () => {
      ghMock.mockRejectedValueOnce(
        Object.assign(new Error('Command failed: gh pr diff'), { stderr: 'HTTP 404: Not Found\n' }),
      );

      await expect(getPrPatch(PR_URL)).rejects.toThrow('HTTP 404: Not Found\nTry: gh auth login');
    });

    it('rejects an empty diff from gh pr diff', async () => {
      ghMock.mockResolvedValueOnce({ stdout: '  \n', stderr: '' });

      await expect(getPrPatch(PR_URL)).rejects.toThrow('No diff content returned from gh pr diff');
    });

    it('pages through review threads with gh api graphql', async () => {
      ghMock
        .mockResolvedValueOnce(reviewThreadsPage('THREAD_1', 'CURSOR_1'))
        .mockResolvedValueOnce(reviewThreadsPage('THREAD_2', null));

      const imports = await getPrCommentImports(PR_URL);

      expect(imports.map((commentImport) => commentImport.id)).toEqual([
        'THREAD_1_COMMENT',
        'THREAD_2_COMMENT',
      ]);
      expect(ghMock).toHaveBeenCalledTimes(2);
      const [[, firstArgs, options], [, secondArgs]] = ghMock.mock.calls;
      expect(firstArgs.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'github.com']);
      expect(firstArgs).not.toContain('endCursor=CURSOR_1');
      expect(secondArgs.slice(-2)).toEqual(['-F', 'endCursor=CURSOR_1']);
      expect(options).toEqual(expect.objectContaining({ maxBuffer: MAX_GH_OUTPUT_BYTES }));
    });

    it('rejects invalid JSON from gh api graphql', async () => {
      ghMock.mockResolvedValueOnce({ stdout: 'not json', stderr: '' });

      await expect(getPrCommentImports(PR_URL)).rejects.toThrow(
        'Invalid JSON returned from gh api graphql',
      );
    });

    it('rejects a URL that is not a pull request without running gh', async () => {
      await expect(getPrCommentImports('not-a-url')).rejects.toThrow('Invalid GitHub PR URL');
      expect(ghMock).not.toHaveBeenCalled();
    });

    it('reads the PR title with gh pr view', async () => {
      ghMock.mockResolvedValueOnce({ stdout: '{"title":"Add the sessions API"}\n', stderr: '' });

      await expect(getPrTitle(PR_URL)).resolves.toBe('Add the sessions API');
      expect(ghMock).toHaveBeenCalledWith(
        'gh',
        ['pr', 'view', '--json', 'title', '--', PR_URL],
        expect.objectContaining({ encoding: 'utf8', maxBuffer: MAX_GH_OUTPUT_BYTES }),
      );
    });

    it('rejects invalid JSON from gh pr view without a login hint', async () => {
      ghMock.mockResolvedValueOnce({ stdout: 'not json', stderr: '' });

      await expect(getPrTitle(PR_URL)).rejects.toThrow(/^Invalid JSON returned from gh pr view$/);
    });

    describe('when gh never exits', () => {
      // A stalled gh must not leave its caller waiting forever.
      const GH_TIMEOUT_MS = 90_000;

      beforeEach(() => {
        vi.useFakeTimers();
        // Like execFile, the run is killed and fails once options.timeout elapses.
        // Without a timeout it hangs.
        ghMock.mockImplementation(
          (file: string, args: string[], options: { timeout?: number; killSignal?: string }) =>
            new Promise((_resolve, reject) => {
              if (options.timeout !== undefined && options.timeout > 0) {
                setTimeout(() => {
                  reject(
                    Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}\n`), {
                      killed: true,
                      code: null,
                      signal: options.killSignal ?? 'SIGTERM',
                      stdout: '',
                      stderr: '',
                    }),
                  );
                }, options.timeout);
              }
            }),
        );
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it.each([
        ['gh pr diff', getPrPatch],
        ['gh api graphql', getPrCommentImports],
        ['gh pr view', getPrTitle],
      ])(
        'kills %s with SIGKILL after 90 seconds and reports the timeout',
        async (_command, run) => {
          let outcome: unknown = 'running';
          void run(PR_URL).then(
            () => {
              outcome = 'resolved';
            },
            (error: unknown) => {
              outcome = error;
            },
          );

          await vi.advanceTimersByTimeAsync(GH_TIMEOUT_MS - 1);
          expect(outcome).toBe('running');
          await vi.advanceTimersByTimeAsync(1);

          expect(outcome).toEqual(
            expect.objectContaining({
              message: expect.stringMatching(/^gh timed out after 90 seconds/),
            }),
          );
          expect(ghMock).toHaveBeenCalledWith(
            'gh',
            expect.any(Array),
            expect.objectContaining({ timeout: GH_TIMEOUT_MS, killSignal: 'SIGKILL' }),
          );
        },
      );
    });
  });
});
