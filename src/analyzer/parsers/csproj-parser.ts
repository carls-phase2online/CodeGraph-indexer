// src/analyzer/parsers/csproj-parser.ts
// Parses .csproj and packages.config files to extract:
//   - ProjectReference entries → REFERENCES_PROJECT edges (Project → Project)
//   - PackageReference entries → REFERENCES_PACKAGE edges (Project → PackageNode)
//
// Design: returns plain data (no direct Neo4j writes) so the caller (analyze.ts)
// controls transaction semantics.

import path from 'path';
import fs from 'fs/promises';
import { createContextLogger } from '../../utils/logger.js';

const logger = createContextLogger('CsprojParser');

export interface ProjectRefInfo {
    /** Relative path (from basePath) of the referenced project directory, e.g. "MyCompany/MyApp/Src/Core/MyProject" */
    relPath: string;
    /** Neo4j entityId for the target Project node: "Project:<relPath>" */
    entityId: string;
}

export interface PackageRefInfo {
    name: string;
    version: string;
}

export interface CsprojParseResult {
    projectRefs: ProjectRefInfo[];
    packageRefs: PackageRefInfo[];
    /** true = SDK-style PackageReference, false = packages.config or no packages */
    sdkStyle: boolean;
}

/**
 * Parses .csproj and packages.config in a project directory to extract dependencies.
 *
 * @param projectDir  Absolute path to the project folder (same dir as .csproj)
 * @param basePath    Absolute path used as the root for computing relative paths
 * @returns           Parsed dependency data, or null if no .csproj found
 */
export async function parseCsproj(
    projectDir: string,
    basePath: string
): Promise<CsprojParseResult | null> {
    // Find .csproj file in the directory
    let files: string[];
    try {
        files = await fs.readdir(projectDir);
    } catch (err) {
        logger.warn(`[CsprojParser] Cannot read directory ${projectDir}: ${(err as Error).message}`);
        return null;
    }

    const csprojFile = files.find(f => f.toLowerCase().endsWith('.csproj'));
    if (!csprojFile) {
        logger.debug(`[CsprojParser] No .csproj found in ${projectDir}`);
        return null;
    }

    const csprojPath = path.join(projectDir, csprojFile);
    let csprojContent = '';
    try {
        csprojContent = await fs.readFile(csprojPath, 'utf-8');
    } catch (err) {
        logger.warn(`[CsprojParser] Cannot read ${csprojPath}: ${(err as Error).message}`);
        return null;
    }

    // --- Parse ProjectReferences ---
    const projectRefs = extractProjectRefs(csprojContent, projectDir, basePath);

    // --- Parse PackageReferences (SDK-style) ---
    const { packages: sdkPackages, found: sdkFound } = extractSdkPackageRefs(csprojContent);

    // --- Parse packages.config (legacy-style) ---
    let legacyPackages: PackageRefInfo[] = [];
    const pkgConfigPath = path.join(projectDir, 'packages.config');
    try {
        const pkgConfigContent = await fs.readFile(pkgConfigPath, 'utf-8');
        legacyPackages = extractLegacyPackageRefs(pkgConfigContent);
        if (legacyPackages.length > 0) {
            logger.debug(`[CsprojParser] Found ${legacyPackages.length} packages in packages.config for ${csprojFile}`);
        }
    } catch {
        // packages.config doesn't exist — that's fine
    }

    // Merge: SDK packages take precedence; only add legacy if no SDK found
    const packageRefs = sdkFound ? sdkPackages : legacyPackages;

    logger.debug(
        `[CsprojParser] ${csprojFile}: ${projectRefs.length} project refs, ` +
        `${packageRefs.length} package refs (${sdkFound ? 'SDK-style' : 'packages.config'})`
    );

    return {
        projectRefs,
        packageRefs,
        sdkStyle: sdkFound,
    };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Extract <ProjectReference Include="..."> entries from .csproj content.
 * Resolves each to a relative path from basePath (matching Project node relPath format).
 */
function extractProjectRefs(
    content: string,
    projectDir: string,
    basePath: string
): ProjectRefInfo[] {
    const refs: ProjectRefInfo[] = [];
    // Match both self-closing and element forms
    const regex = /<ProjectReference\s[^>]*Include="([^"]+)"/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
        const includePath = (match[1] ?? '').replace(/\\/g, '/');
        try {
            // Resolve the include path relative to the .csproj's directory
            const absRefPath = path.resolve(projectDir, includePath.replace(/\//g, path.sep));
            // The referenced "project" is the directory containing the .csproj
            const refDir = path.dirname(absRefPath);
            const relPath = path.relative(basePath, refDir).replace(/\\/g, '/');
            // Refuse ProjectReferences that resolve outside basePath. A crafted .csproj
            // with `Include="../../../etc/evil.csproj"` would otherwise land an
            // entityId of `Project:../../../etc` in Neo4j, poisoning later queries.
            if (relPath.startsWith('../') || path.isAbsolute(relPath)) {
                logger.warn(`[CsprojParser] ProjectReference resolves outside basePath, skipping: ${includePath} -> ${relPath}`);
                continue;
            }
            refs.push({ relPath, entityId: `Project:${relPath}` });
        } catch (err) {
            logger.warn(`[CsprojParser] Could not resolve ProjectReference "${includePath}": ${(err as Error).message}`);
        }
    }

    return refs;
}

/**
 * Extract <PackageReference Include="..." Version="..."> from SDK-style .csproj.
 * Handles both forms:
 *   1. <PackageReference Include="Foo" Version="1.2.3" />  (Version as attribute)
 *   2. <PackageReference Include="Foo"><Version>1.2.3</Version></PackageReference>  (child element)
 */
function extractSdkPackageRefs(content: string): { packages: PackageRefInfo[]; found: boolean } {
    const packages: PackageRefInfo[] = [];

    // Match the entire PackageReference element — either self-closing or with a body.
    // Capture group 1 is the body (undefined for self-closing).
    // Using a non-greedy [\s\S]*? for body so adjacent elements don't get coalesced.
    const elementRegex = /<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference\s*>)/gi;
    let match: RegExpExecArray | null;

    while ((match = elementRegex.exec(content)) !== null) {
        const attrs = match[1] ?? '';
        const body  = match[2] ?? '';

        const nameMatch = /\bInclude\s*=\s*"([^"]+)"/i.exec(attrs);
        if (!nameMatch) continue;
        const name = nameMatch[1] ?? '';

        // Prefer Version="..." attribute; fall back to <Version>...</Version> child element.
        const attrVersionMatch  = /\bVersion\s*=\s*"([^"]+)"/i.exec(attrs);
        const childVersionMatch = body ? /<Version\s*>\s*([^<\s][^<]*?)\s*<\/Version\s*>/i.exec(body) : null;

        const version = attrVersionMatch?.[1] ?? childVersionMatch?.[1] ?? '';

        packages.push({ name, version });
    }

    // Deduplicate by name (case-insensitive, keep last occurrence).
    const seen = new Map<string, PackageRefInfo>();
    for (const p of packages) {
        seen.set(p.name.toLowerCase(), p);
    }

    return { packages: Array.from(seen.values()), found: packages.length > 0 };
}

/**
 * Extract <package id="Foo" version="1.2.3"> from legacy packages.config.
 */
function extractLegacyPackageRefs(content: string): PackageRefInfo[] {
    const packages: PackageRefInfo[] = [];
    const regex = /<package\s[^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
        const element = match[0];
        const idMatch = /\bid="([^"]+)"/i.exec(element);
        const versionMatch = /\bversion="([^"]+)"/i.exec(element);
        if (idMatch) {
            packages.push({
                name: idMatch[1] ?? '',
                version: versionMatch ? (versionMatch[1] ?? '') : '',
            });
        }
    }

    return packages;
}
