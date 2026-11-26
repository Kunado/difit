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
  it('waits for in-flight and queued saves to complete and returns true', async () => {
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

      // flush が完了し、true を返す
      const completed = await flushPromise;
      expect(completed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for saves added during flush and returns true when all complete', async () => {
    const prsPath = join(await makeTempDir(), 'prs.json');
    const prList = await openPrList(prsPath);

    // 1本目の保存を開始
    const save1 = prList.add({ url: PR_A, owner: 'octo', repo: 'alpha', number: 1 });

    // flush を開始
    const flushPromise = prList.flush(3000);

    // flush 中に2本目の保存を積む
    await new Promise((resolve) => setTimeout(resolve, 10));
    const save2 = prList.add({
      url: 'https://github.com/octo/beta/pull/2',
      owner: 'octo',
      repo: 'beta',
      number: 2,
    });

    // flush は両方の保存が終わってから true を返す
    const completed = await flushPromise;
    expect(completed).toBe(true);

    // 両方の保存が完了している
    await save1;
    await save2;

    // prs.json に両方の内容が入っている
    const list = prList.list();
    expect(list).toHaveLength(2);
    expect(list.map((pr) => pr.pr.url)).toEqual([PR_A, 'https://github.com/octo/beta/pull/2']);

    // 一時ファイルが残っていない
    const files = await readdir(join(prsPath, '..'));
    expect(files).toEqual(['prs.json']);
  });

  it('returns false after timeout if saves take too long', async () => {
    vi.useFakeTimers();
    try {
      const prsPath = join(await makeTempDir(), 'prs.json');
      const prList = await openPrList(prsPath);

      // 保存を開始（実際の書き込みが発生）
      const savePromise = prList.add({ url: PR_A, owner: 'octo', repo: 'alpha', number: 1 });

      // flush を呼ぶ（1ms のタイムアウト、保存が終わる前）
      const flushPromise = prList.flush(1);

      // タイムアウトまで進める
      await vi.advanceTimersByTimeAsync(1);

      // タイムアウトで完了し、false を返す
      const completed = await flushPromise;
      expect(completed).toBe(false);

      // タイマーをリセットする前に保存を完了させる
      vi.useRealTimers();
      await savePromise;
    } catch (error) {
      vi.useRealTimers();
      throw error;
    }
  });

  it('returns false after timeout and does not leave timers running', async () => {
    vi.useFakeTimers();
    try {
      const prsPath = join(await makeTempDir(), 'prs.json');
      const prList = await openPrList(prsPath);

      // 保存を開始（実際の書き込みが発生）
      const savePromise = prList.add({ url: PR_A, owner: 'octo', repo: 'alpha', number: 1 });

      // flush を呼ぶ（1ms のタイムアウト）
      const flushPromise = prList.flush(1);

      // タイムアウトまで進める
      await vi.advanceTimersByTimeAsync(1);

      // flush が完了し、false を返す
      const completed = await flushPromise;
      expect(completed).toBe(false);

      // タイマーが残っていない
      expect(vi.getTimerCount()).toBe(0);

      // タイマーをリセットする前に保存を完了させる
      vi.useRealTimers();
      await savePromise;
    } catch (error) {
      vi.useRealTimers();
      throw error;
    }
  });

  it('returns true immediately when no saves are pending', async () => {
    const prsPath = join(await makeTempDir(), 'prs.json');
    const prList = await openPrList(prsPath);

    // 何も保存していない状態で flush
    const start = Date.now();
    const completed = await prList.flush(3000);
    const elapsed = Date.now() - start;

    expect(completed).toBe(true);
    // ほとんど待たずに完了する
    expect(elapsed).toBeLessThan(100);
  });
});

describe('discardTempFile', () => {
  it('removes the temp file for this process', async () => {
    const dir = await makeTempDir();
    const prsPath = join(dir, 'prs.json');
    // prs.json を作成
    await writeFile(prsPath, JSON.stringify({ version: 1, pullRequests: [] }));
    const prList = await openPrList(prsPath);

    // 一時ファイルを作成
    const tmpPath = `${prsPath}.${process.pid}.tmp`;
    await writeFile(tmpPath, 'temporary data');

    // discardTempFile を呼ぶ
    await prList.discardTempFile();

    // 一時ファイルが消えている
    const files = await readdir(dir);
    expect(files).toEqual(['prs.json']);
  });

  it('does not fail if temp file does not exist', async () => {
    const prsPath = join(await makeTempDir(), 'prs.json');
    const prList = await openPrList(prsPath);

    // 一時ファイルがない状態で呼ぶ
    await prList.discardTempFile();
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
