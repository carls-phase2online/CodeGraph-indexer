import { describe, it, expect } from 'vitest';
import path from 'path';
import { parseCsproj } from './csproj-parser.js';

// Resolve a fixture path relative to the project root (process.cwd() when running vitest).
function fixturePath(...segments: string[]): string {
    return path.resolve(process.cwd(), 'test_fixtures', 'csproj', ...segments);
}

describe('parseCsproj', () => {

    // -------------------------------------------------------------------------
    // ProjectReference extraction
    // -------------------------------------------------------------------------
    describe('ProjectReference extraction', () => {
        it('extracts ProjectReference paths and computes relative entityIds', async () => {
            // Fixture: test_fixtures/csproj/project-ref/Src/App/App.csproj
            // Contains: <ProjectReference Include="..\Lib\Lib.csproj" />
            // basePath:  test_fixtures/csproj/project-ref
            // Expected relPath for the referenced lib: 'Src/Lib'
            const projectDir = fixturePath('project-ref', 'Src', 'App');
            const base       = fixturePath('project-ref');

            const result = await parseCsproj(projectDir, base);

            expect(result).not.toBeNull();
            expect(result!.projectRefs).toHaveLength(1);

            const ref = result!.projectRefs[0];
            expect(ref.relPath).toBe('Src/Lib');
            expect(ref.entityId).toBe('Project:Src/Lib');
        });

        it('skips ProjectReferences that escape basePath via ../ traversal', async () => {
            // Fixture: test_fixtures/csproj/traversal-guard/Src/App/App.csproj
            // Contains: <ProjectReference Include="..\..\..\evil.csproj" />
            // The resolved directory escapes basePath → must be silently dropped.
            const projectDir = fixturePath('traversal-guard', 'Src', 'App');
            const base       = fixturePath('traversal-guard');

            const result = await parseCsproj(projectDir, base);

            expect(result).not.toBeNull();
            expect(result!.projectRefs).toHaveLength(0);
        });

        it('skips ProjectReferences with an absolute Include path', async () => {
            // Fixture: test_fixtures/csproj/traversal-guard-absolute/Src/App/App.csproj
            // Contains: <ProjectReference Include="C:\Windows\evil.csproj" />
            // path.relative returns an absolute path on a different drive (Windows) or an
            // escape sequence on the same drive — both are rejected by the isAbsolute / startsWith('../')
            // guards in extractProjectRefs.
            const projectDir = fixturePath('traversal-guard-absolute', 'Src', 'App');
            const base       = fixturePath('traversal-guard-absolute');

            const result = await parseCsproj(projectDir, base);

            expect(result).not.toBeNull();
            expect(result!.projectRefs).toHaveLength(0);
        });
    });

    // -------------------------------------------------------------------------
    // PackageReference extraction
    // -------------------------------------------------------------------------
    describe('PackageReference extraction', () => {
        it('extracts SDK-style PackageReference with inline Version="…" attribute', async () => {
            // Fixture: test_fixtures/csproj/package-ref-attr/App.csproj
            const projectDir = fixturePath('package-ref-attr');
            const result = await parseCsproj(projectDir, projectDir);

            expect(result).not.toBeNull();
            expect(result!.sdkStyle).toBe(true);

            const names = result!.packageRefs.map(p => p.name);
            expect(names).toContain('Newtonsoft.Json');
            expect(names).toContain('Serilog');

            const json = result!.packageRefs.find(p => p.name === 'Newtonsoft.Json');
            expect(json?.version).toBe('13.0.3');
        });

        it('extracts SDK-style PackageReference with child-element <Version>…</Version>', async () => {
            // Fixture: test_fixtures/csproj/package-ref-child/App.csproj
            const projectDir = fixturePath('package-ref-child');
            const result = await parseCsproj(projectDir, projectDir);

            expect(result).not.toBeNull();
            expect(result!.sdkStyle).toBe(true);

            const json = result!.packageRefs.find(p => p.name === 'Newtonsoft.Json');
            expect(json).toBeDefined();
            expect(json?.version).toBe('13.0.3');

            const serilog = result!.packageRefs.find(p => p.name === 'Serilog');
            expect(serilog?.version).toBe('3.1.1');
        });

        it('extracts legacy packages.config <package id version />', async () => {
            // Fixture: test_fixtures/csproj/packages-config/
            // App.csproj has no <PackageReference>; packages.config has Newtonsoft.Json + Serilog.
            const projectDir = fixturePath('packages-config');
            const result = await parseCsproj(projectDir, projectDir);

            expect(result).not.toBeNull();
            expect(result!.sdkStyle).toBe(false);

            const names = result!.packageRefs.map(p => p.name);
            expect(names).toContain('Newtonsoft.Json');
            expect(names).toContain('Serilog');

            const json = result!.packageRefs.find(p => p.name === 'Newtonsoft.Json');
            expect(json?.version).toBe('13.0.3');
        });

        it('SDK PackageReferences take precedence over packages.config when both present', async () => {
            // Fixture: test_fixtures/csproj/sdk-precedence/
            // App.csproj has PackageReference Foo@2.0.0
            // packages.config has Foo@1.0.0 — must be ignored.
            const projectDir = fixturePath('sdk-precedence');
            const result = await parseCsproj(projectDir, projectDir);

            expect(result).not.toBeNull();
            expect(result!.sdkStyle).toBe(true);

            expect(result!.packageRefs).toHaveLength(1);
            expect(result!.packageRefs[0].name).toBe('Foo');
            expect(result!.packageRefs[0].version).toBe('2.0.0');
        });

        it('reports sdkStyle: true when SDK packages found', async () => {
            const projectDir = fixturePath('package-ref-attr');
            const result = await parseCsproj(projectDir, projectDir);
            expect(result!.sdkStyle).toBe(true);
        });

        it('reports sdkStyle: false when only legacy packages.config present', async () => {
            const projectDir = fixturePath('packages-config');
            const result = await parseCsproj(projectDir, projectDir);
            expect(result!.sdkStyle).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // Edge cases
    // -------------------------------------------------------------------------
    describe('edge cases', () => {
        it('returns empty arrays for an empty .csproj (no refs, no packages)', async () => {
            // Fixture: test_fixtures/csproj/empty/App.csproj
            const projectDir = fixturePath('empty');
            const result = await parseCsproj(projectDir, projectDir);

            expect(result).not.toBeNull();
            expect(result!.projectRefs).toHaveLength(0);
            expect(result!.packageRefs).toHaveLength(0);
        });

        it('does not throw on malformed XML', async () => {
            // Fixture: test_fixtures/csproj/malformed/App.csproj — mismatched close tag.
            // The regex-based parser must not crash; it may find zero or one package.
            const projectDir = fixturePath('malformed');
            await expect(parseCsproj(projectDir, projectDir)).resolves.not.toThrow();
        });

        it('returns null when projectDir contains no .csproj', async () => {
            // The fixture directory for a no-csproj case is simply a directory that has no .csproj.
            // Use the csproj root dir itself (test_fixtures/csproj) — it has no .csproj directly.
            const projectDir = fixturePath();
            const result = await parseCsproj(projectDir, projectDir);
            expect(result).toBeNull();
        });
    });
});
