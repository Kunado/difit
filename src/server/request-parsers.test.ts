import { describe, expect, it } from 'vitest';

import { parseBaseMode, parseEditorRequest } from './request-parsers.js';

describe('parseBaseMode', () => {
  it.each([
    ['merge-base', 'merge-base'],
    ['direct', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('reads %j as %j', (value, expected) => {
    expect(parseBaseMode(value)).toBe(expected);
  });
});

describe('parseEditorRequest', () => {
  it('keeps string fields and drops the rest', () => {
    expect(parseEditorRequest({ id: 'vscode', command: 42, argsTemplate: '-g %file' })).toEqual({
      id: 'vscode',
      command: undefined,
      argsTemplate: '-g %file',
    });
  });

  it.each([null, undefined, 'vscode'])('returns empty fields for %j', (value) => {
    expect(parseEditorRequest(value)).toEqual({
      id: undefined,
      command: undefined,
      argsTemplate: undefined,
    });
  });
});
