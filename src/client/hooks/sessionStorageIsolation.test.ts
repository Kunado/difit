import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { DiffFile } from '../../types/diff';

import { useDiffComments } from './useDiffComments';
import { useViewedFiles } from './useViewedFiles';

// The multi-session server reports every PR diff as stdin...stdin and gives each PR
// session its own repositoryId (a sha256 of the PR URL). Two PRs open in one browser
// share an origin, so only the repositoryId keeps their saved state apart.
const PR_A = 'a'.repeat(64);
const PR_B = 'b'.repeat(64);

const sharedFile: DiffFile = {
  path: 'src/shared.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  chunks: [],
};

const openComments = (repositoryId: string) =>
  renderHook(() => useDiffComments('stdin', 'stdin', undefined, undefined, repositoryId)).result;

const openViewedFiles = (repositoryId: string) =>
  renderHook(() =>
    useViewedFiles('stdin', 'stdin', undefined, undefined, [sharedFile], repositoryId),
  ).result;

afterEach(() => {
  localStorage.clear();
});

describe('two PR sessions in one browser', () => {
  it('keep their comments apart', () => {
    const prA = openComments(PR_A);
    act(() => {
      prA.current.addComment({ filePath: sharedFile.path, body: 'on PR A', side: 'new', line: 1 });
    });

    expect(openComments(PR_B).current.comments).toEqual([]);
    expect(openComments(PR_A).current.comments.map((comment) => comment.body)).toEqual(['on PR A']);
  });

  it('keep their viewed files apart', async () => {
    const prA = openViewedFiles(PR_A);
    await act(async () => {
      await prA.current.toggleFileViewed(sharedFile.path, sharedFile);
    });
    expect(prA.current.viewedFiles.has(sharedFile.path)).toBe(true);

    const prB = openViewedFiles(PR_B);
    const prAReopened = openViewedFiles(PR_A);

    await waitFor(() => expect(prAReopened.current.viewedFiles.has(sharedFile.path)).toBe(true));
    expect(prB.current.viewedFiles.has(sharedFile.path)).toBe(false);
  });
});
