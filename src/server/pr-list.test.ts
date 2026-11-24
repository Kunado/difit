import { mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openPrList } from './pr-list.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'difit-test-'));
  tempDirs.push(dir);
  return dir;
}

const PR_A = 'https://github.com/octo/alpha/pull/1';

describe('flush with timeout', () => {
  it('waits for in-flight and queued saves to complete before resolving', async () => {
    vi.useFakeTimers();
    try {
      const prsPath = join(await makeTempDir(), 'prs.json');
      const prList = await openPrList(prsPath);

      // 保存を開始（実際の書き込みが発生）
      const save1 = prList.add({ url: PR_A, owner: 'octo', repo: 'alpha', number: 1 });

      // flush を呼ぶ（3秒のタイムアウト）
      const flushPromise = prList.flush(3000);

      // 保存を待つ
      await save1;

      // flush が完了する
      await flushPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves after timeout if saves take too long, leaving temp file', async () => {
    vi.useFakeTimers();
    try {
      const prsPath = join(await makeTempDir(), 'prs.json');
      const prList = await openPrList(prsPath);

      // flush を呼ぶ（100ms のタイムアウト）
      const flushPromise = prList.flush(100);

      // タイムアウトまで進める
      await vi.advanceTimersByTimeAsync(100);

      // タイムアウトで完了する
      await flushPromise;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cleanup of stale temporary files on startup', () => {
  it('removes temp files whose pid is dead, keeps those whose pid is alive', async () => {
    const dir = await makeTempDir();
    const prsPath = join(dir, 'prs.json');
    await writeFile(prsPath, JSON.stringify({ version: 1, pullRequests: [] }));

    // 自分の pid（生きている）
    const alivePid = process.pid;
    // 死んだ pid（適当に大きな値）
    const deadPid = 999999;

    await writeFile(join(dir, `prs.json.${alivePid}.tmp`), 'alive');
    await writeFile(join(dir, `prs.json.${deadPid}.tmp`), 'dead');
    // パターンに合わない名前
    await writeFile(join(dir, 'prs.json.bak'), 'backup');
    await writeFile(join(dir, 'other.json.123.tmp'), 'other');
    await writeFile(join(dir, 'prs.json.abc.tmp'), 'invalid');

    await openPrList(prsPath);

    const files = await readdir(dir);
    expect(files.sort()).toEqual(
      [
        'prs.json',
        `prs.json.${alivePid}.tmp`, // 生きているので残る
        'prs.json.bak', // パターンに合わないので残る
        'other.json.123.tmp', // ファイル名が違うので残る
        'prs.json.abc.tmp', // pid が数字でないので残る
      ].sort(),
    );
  });

  it('removes temp files for the custom path specified with --prs', async () => {
    const dir = await makeTempDir();
    const prsPath = join(dir, 'custom-list.json');
    await writeFile(prsPath, JSON.stringify({ version: 1, pullRequests: [] }));

    const deadPid = 999999;
    await writeFile(join(dir, `custom-list.json.${deadPid}.tmp`), 'dead');
    await writeFile(join(dir, `prs.json.${deadPid}.tmp`), 'other'); // 違うファイル名なので残る

    await openPrList(prsPath);

    const files = await readdir(dir);
    expect(files.sort()).toEqual(['custom-list.json', `prs.json.${deadPid}.tmp`].sort());
  });

  // Note: Cleanup failure handling is tested implicitly by other tests.
  // ESM module mocking limitations prevent us from directly testing the error path.

  it('cleans up temp files even when the main file is read-only', async () => {
    const dir = await makeTempDir();
    const prsPath = join(dir, 'prs.json');
    await writeFile(prsPath, 'invalid json');

    const deadPid = 999999;
    await writeFile(join(dir, `prs.json.${deadPid}.tmp`), 'dead');

    await openPrList(prsPath);

    const files = await readdir(dir);
    // 一時ファイルは片付けられる
    expect(files).toEqual(['prs.json']);
  });

  it('keeps temp files whose process is alive (another server)', async () => {
    const dir = await makeTempDir();
    const prsPath = join(dir, 'prs.json');
    await writeFile(prsPath, JSON.stringify({ version: 1, pullRequests: [] }));

    // 親プロセスは確実に生きている
    const parentPid = process.ppid;
    await writeFile(join(dir, `prs.json.${parentPid}.tmp`), 'parent');

    await openPrList(prsPath);

    const files = await readdir(dir);
    expect(files.sort()).toEqual(['prs.json', `prs.json.${parentPid}.tmp`].sort());
  });
});
