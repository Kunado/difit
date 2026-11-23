import { type BaseMode } from '../types/diff.js';

export const parseBaseMode = (value: unknown): BaseMode | undefined => {
  if (value === 'merge-base') {
    return 'merge-base';
  }

  return undefined;
};

interface EditorRequest {
  readonly id: string | undefined;
  readonly command: string | undefined;
  readonly argsTemplate: string | undefined;
}

export function parseEditorRequest(value: unknown): EditorRequest {
  if (!value || typeof value !== 'object') {
    return { id: undefined, command: undefined, argsTemplate: undefined };
  }
  const candidate = value as {
    id?: unknown;
    command?: unknown;
    argsTemplate?: unknown;
  };
  return {
    id: typeof candidate.id === 'string' ? candidate.id : undefined,
    command: typeof candidate.command === 'string' ? candidate.command : undefined,
    argsTemplate: typeof candidate.argsTemplate === 'string' ? candidate.argsTemplate : undefined,
  };
}
