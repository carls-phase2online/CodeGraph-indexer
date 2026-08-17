import { describe, it, expect } from 'vitest';
import path from 'path';
import { relativizeFilePath } from './parser-utils.js';

// Use POSIX-style paths throughout so test values are readable on any platform.
// path.resolve('/a/b/c.ts') always returns an absolute path; on Windows it will
// be anchored to the drive of the current working directory, but the *relative*
// computations are identical.

const abs = (...segments: string[]) => path.resolve('/', ...segments).replace(/\\/g, '/');

describe('relativizeFilePath', () => {
    it('returns forward-slashed absolute when basePath is undefined', () => {
        const filePath = abs('project', 'src', 'foo.ts');
        const out = relativizeFilePath(filePath);
        // No basePath → always absolute, always forward-slashed.
        expect(out).toBe(filePath);
        expect(out).not.toContain('\\');
    });

    it('returns relative path when basePath is a strict ancestor', () => {
        const base = abs('project');
        const file = abs('project', 'src', 'utils', 'foo.ts');
        const out = relativizeFilePath(file, base);
        expect(out).toBe('src/utils/foo.ts');
    });

    it('returns relative path when file is directly inside basePath', () => {
        const base = abs('project');
        const file = abs('project', 'index.ts');
        const out = relativizeFilePath(file, base);
        expect(out).toBe('index.ts');
    });

    it('falls back to absolute when filePath resolves to the same location as basePath', () => {
        const base = abs('project');
        // A file path that resolves to the same directory as basePath — rel would be '' or '.'.
        const out = relativizeFilePath(base, base);
        // Must not return '' or '.'; must return the absolute forward-slashed path.
        expect(out).toBe(abs('project'));
        expect(out.length).toBeGreaterThan(1);
    });

    it('falls back to absolute when basePath is a sibling directory (../  escape)', () => {
        const base = abs('project', 'a');
        const file = abs('project', 'b', 'foo.ts');
        // path.relative(a, b/foo.ts) === '../b/foo.ts' → escape → fallback
        const out = relativizeFilePath(file, base);
        expect(out).toBe(abs('project', 'b', 'foo.ts'));
    });

    it('falls back to absolute when basePath is a disjoint subtree', () => {
        const base = abs('other', 'repo');
        const file = abs('project', 'src', 'foo.ts');
        const out = relativizeFilePath(file, base);
        expect(out).toBe(abs('project', 'src', 'foo.ts'));
    });

    it('normalizes Windows backslashes to forward slashes in output', () => {
        const base = abs('project');
        const file = abs('project', 'src', 'foo.ts');
        // Force backslash separators into the inputs (simulating Windows raw paths).
        const winBase = base.replace(/\//g, '\\');
        const winFile = file.replace(/\//g, '\\');
        const out = relativizeFilePath(winFile, winBase);
        expect(out).not.toContain('\\');
        expect(out).toBe('src/foo.ts');
    });

    it('handles mixed separators in input filePath', () => {
        const base = abs('project');
        // Mix slashes inside the file segment.
        const mixedFile = abs('project') + '/src\\bar.ts';
        // path.resolve normalizes the mixed separators.
        const out = relativizeFilePath(mixedFile, base);
        expect(out).not.toContain('\\');
        expect(out).toBe('src/bar.ts');
    });

    it('treats trailing slash on basePath the same as no trailing slash', () => {
        const base = abs('project');
        const file = abs('project', 'src', 'foo.ts');
        const outNoSlash  = relativizeFilePath(file, base);
        const outWithSlash = relativizeFilePath(file, base + '/');
        expect(outNoSlash).toBe('src/foo.ts');
        expect(outWithSlash).toBe('src/foo.ts');
    });

    it('falls back to absolute on empty-string filePath (resolves to cwd)', () => {
        // path.resolve('') === process.cwd(). This is a defined edge case — the helper
        // should return the absolute cwd path, not an empty string.
        const base = abs('project');
        const out = relativizeFilePath('', base);
        // Result must be a non-empty absolute path.
        expect(out.length).toBeGreaterThan(0);
        expect(path.isAbsolute(out.replace(/\//g, path.sep))).toBe(true);
    });

    it('does not mutate inputs', () => {
        const base = abs('project');
        const file = abs('project', 'src', 'foo.ts');
        const baseOriginal = base;
        const fileOriginal = file;
        relativizeFilePath(file, base);
        expect(base).toBe(baseOriginal);
        expect(file).toBe(fileOriginal);
    });
});
