import { readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openPrList } from './pr-list.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function makeTempDir(): Promise<string> {
  const dir = await readFile('/dev/urandom', { encoding: 'hex' }).then(
    (buf) => join(tmpdir(), `difit-test-${buf.toString('hex', 0, 8)}`),
    () => join(tmpdir(), `difit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  );
  tempDirs.push(dir);
  return dir;
}

const PR_A = 'https://github.com/octo/alpha/pull/1';

describe('flush with timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for in-flight and queued saves to complete before resolving', async () => {
    const prsPath = join(await makeTempDir(), 'prs.json');
    const prList = await openPrList(prsPath);

    // 保存を遅くするために実際の writeFile をモック
    let resolveWrite: (() => void) | undefined;
    const writePromise = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    vi.spyOn(await import('fs/promises'), 'writeFile').mockImplementation(async () => {
      await writePromise;
    });

    // 保存を開始
    const save1 = prList.add({ url: PR_A, owner: 'octo', repo: 'alpha', number: 1 });

    // flush を呼ぶ（3秒のタイムアウト）
    const flushPromise = prList.flush(3000);

    // まだ終わっていない
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve(); // マイクロタスクを実行
    let settled = false;
    void flushPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // 保存を完了させる
    resolveWrite?.();
    await save1;

    // flush が完了する
    await flushPromise;
    expect(settled).toBe(true);
  });

  it('resolves after timeout if saves take too long, leaving temp file', async () => {
    const prsPath = join(await makeTempDir(), 'prs.json');
    const prList = await openPrList(prsPath);

    // 保存を永遠に保留するモック
    vi.spyOn(await import('fs/promises'), 'writeFile').mockImplementation(
      () => new Promise(() => {}),
    );

    // 保存を開始
    void prList.add({ url: PR_A, owner: 'octo', repo: 'alpha', number: 1 });

    // flush を呼ぶ（100ms のタイムアウト）
    const flushPromise = prList.flush(100);

    // タイムアウトまで進める
    await vi.advanceTimersByTimeAsync(100);

    // タイムアウトで完了する
    await flushPromise;
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

  it('does not fail startup if temp file cleanup fails', async () => {
    const dir = await makeTempDir();
    const prsPath = join(dir, 'prs.json');
    await writeFile(prsPath, JSON.stringify({ version: 1, pullRequests: [] }));

    const deadPid = 999999;
    const tmpPath = join(dir, `prs.json.${deadPid}.tmp`);
    await writeFile(tmpPath, 'dead');

    // rm が失敗するようにモック（ただし readdir は通す）
    const originalRm = (await import('fs/promises')).rm;
    vi.spyOn(await import('fs/promises'), 'rm').mockImplementation(async (path) => {
      if (typeof path === 'string' && path === tmpPath) {
        throw new Error('Permission denied');
      }
      return originalRm(path, { force: true });
    });

    // 起動は成功する
    const prList = await openPrList(prsPath);
    expect(prList.list()).toEqual([]);
  });

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
