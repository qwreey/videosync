import type { Provider } from '../src/providers/descriptor.ts';

export interface Builtin {
  file: string;
  id: string;
  source: string;
  sha256: string;
  provider: Provider;
}

export const PROVIDERS_DIR: string;
export const GENERATED: string;
export function loadBuiltins(dir?: string): Builtin[];
export function renderGenerated(builtins: readonly Builtin[]): string;
export function writeGenerated(dir?: string): Builtin[];
export function matchPatterns(builtins: readonly Builtin[]): string[];
