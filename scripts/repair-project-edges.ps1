# repair-project-edges.ps1
# Restores REFERENCES_PROJECT and REFERENCES_PACKAGE edges by re-reading
# all .csproj files under a given source root.
#
# Reads every .csproj file, extracts ProjectReference and PackageReference /
# packages.config entries, and writes them to Neo4j.
#
# Safe to re-run: all writes use MERGE so no duplicates are created.
#
# Usage:
#   .\scripts\repair-project-edges.ps1 -SrcRoot "C:\MyRepo\Src" -BaseDir "C:\MyRepo"
#   .\scripts\repair-project-edges.ps1 -SrcRoot "C:\MyRepo\Src" -BaseDir "C:\MyRepo" -DryRun
#   .\scripts\repair-project-edges.ps1 -SrcRoot "C:\MyRepo\Src\Core" -BaseDir "C:\MyRepo"  # Limit to one folder

param(
    [Parameter(Mandatory)]
    [string]$SrcRoot,                          # Root folder to search for .csproj files

    [Parameter(Mandatory)]
    [string]$BaseDir,                          # Repo root used to compute relative paths

    [string]$Neo4jUri  = "http://localhost:7474/db/codegraph/tx/commit",
    [string]$Neo4jUser = "neo4j",
    [string]$Neo4jPass = "neo4j",
    [switch]$DryRun
)

$cred     = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${Neo4jUser}:${Neo4jPass}"))
$headers  = @{ 'Content-Type'='application/json'; 'Accept'='application/json'; 'Authorization'="Basic $cred" }

function Invoke-Cypher($query, $params) {
    $s = @{ statement = $query }
    if ($null -ne $params) { $s.parameters = $params }
    $b = ConvertTo-Json @{ statements = @($s) } -Depth 10 -Compress
    $r = Invoke-RestMethod -Uri $Neo4jUri -Method Post -Headers $headers -Body $b
    if ($r.errors.Count -gt 0) { throw ("Cypher error: " + $r.errors[0].message) }
    return $r.results[0]
}

function Get-RelPath($absPath) {
    return $absPath.Replace($BaseDir, '').TrimStart('\').Replace('\', '/')
}

# ---- Discover .csproj files ---------------------------------------------------
$csprojFiles = Get-ChildItem -Path $SrcRoot -Recurse -Filter '*.csproj' |
    Where-Object { $_.FullName -notmatch '\\(bin|obj)\\' }

Write-Host ""
Write-Host "=== repair-project-edges.ps1 ===" -ForegroundColor Cyan
Write-Host ("  Source  : {0}" -f $SrcRoot)
Write-Host ("  BaseDir : {0}" -f $BaseDir)
Write-Host ("  .csproj : {0} files" -f $csprojFiles.Count)
Write-Host ("  DryRun  : {0}" -f $DryRun.IsPresent)
Write-Host ""

$totalProjRefs = 0
$totalPkgRefs  = 0
$processed     = 0
$failed        = 0

foreach ($csprojFile in $csprojFiles) {
    $projDir    = Split-Path $csprojFile.FullName -Parent
    $projRelDir = Get-RelPath $projDir
    $entityId   = "Project:$projRelDir"

    $content = Get-Content $csprojFile.FullName -Raw -Encoding UTF8

    # --- ProjectReferences ---
    $projRefs = @()
    $prMatches = [regex]::Matches($content, '<ProjectReference\s[^>]*Include="([^"]+)"', 'IgnoreCase')
    foreach ($m in $prMatches) {
        $includePath = $m.Groups[1].Value.Replace('/', '\')
        try {
            $absRefPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($projDir, $includePath))
            $refDir     = Split-Path $absRefPath -Parent
            $refRelDir  = Get-RelPath $refDir
            $projRefs  += @{ entityId = "Project:$refRelDir"; relPath = $refRelDir }
        } catch { }
    }

    # --- PackageReferences (SDK-style) ---
    $pkgRefs  = @()
    $sdkStyle = $false
    $pkgMatches = [regex]::Matches($content, '<PackageReference\s[^>]*>', 'IgnoreCase')
    foreach ($m in $pkgMatches) {
        $elem  = $m.Value
        $nameM = [regex]::Match($elem, 'Include="([^"]+)"', 'IgnoreCase')
        $verM  = [regex]::Match($elem, 'Version="([^"]+)"', 'IgnoreCase')
        if ($nameM.Success) {
            $pkgRefs  += @{ name = $nameM.Groups[1].Value; version = if ($verM.Success) { $verM.Groups[1].Value } else { '' } }
            $sdkStyle  = $true
        }
    }

    # --- Legacy packages.config ---
    if (-not $sdkStyle) {
        $pkgConfig = Join-Path $projDir 'packages.config'
        if (Test-Path $pkgConfig) {
            $pkgContent  = Get-Content $pkgConfig -Raw -Encoding UTF8
            $legMatches  = [regex]::Matches($pkgContent, '<package\s[^>]*>', 'IgnoreCase')
            foreach ($m in $legMatches) {
                $elem  = $m.Value
                $idM   = [regex]::Match($elem, '\bid="([^"]+)"', 'IgnoreCase')
                $verM  = [regex]::Match($elem, '\bversion="([^"]+)"', 'IgnoreCase')
                if ($idM.Success) {
                    $pkgRefs += @{ name = $idM.Groups[1].Value; version = if ($verM.Success) { $verM.Groups[1].Value } else { '' } }
                }
            }
        }
    }

    # Deduplicate packages by lower-case name
    $seen     = @{}
    $uniquePkg = @()
    foreach ($p in $pkgRefs) {
        $key = $p.name.ToLower()
        if (-not $seen.ContainsKey($key)) { $seen[$key] = $true; $uniquePkg += $p }
    }
    $pkgRefs = $uniquePkg

    $processed++
    if ($projRefs.Count -eq 0 -and $pkgRefs.Count -eq 0) { continue }

    if ($DryRun) {
        Write-Host ("  [{0}] {1}" -f $processed, $projRelDir)
        if ($projRefs.Count -gt 0) { Write-Host ("    ProjectRefs: {0}" -f $projRefs.Count) }
        if ($pkgRefs.Count  -gt 0) { $styleLabel = if ($sdkStyle) { 'SDK' } else { 'packages.config' }; Write-Host ("    PackageRefs: {0} ({1})" -f $pkgRefs.Count, $styleLabel) }
        $totalProjRefs += $projRefs.Count
        $totalPkgRefs  += $pkgRefs.Count
        continue
    }

    # --- Write REFERENCES_PROJECT ---
    if ($projRefs.Count -gt 0) {
        try {
            Invoke-Cypher @'
MATCH (source:Project {entityId: $sourceId})
UNWIND $targets AS t
MERGE (target:Project {entityId: t.entityId})
ON CREATE SET target.relPath = t.relPath
MERGE (source)-[:REFERENCES_PROJECT]->(target)
'@ @{ sourceId = $entityId; targets = $projRefs } | Out-Null
            $totalProjRefs += $projRefs.Count
        } catch {
            Write-Host ("  WARN: ProjectRefs failed for {0}: {1}" -f $projRelDir, $_) -ForegroundColor Yellow
            $failed++
        }
    }

    # --- Write REFERENCES_PACKAGE ---
    if ($pkgRefs.Count -gt 0) {
        try {
            Invoke-Cypher @'
MATCH (source:Project {entityId: $sourceId})
UNWIND $pkgs AS pkg
MERGE (pn:PackageNode {entityId: 'package:' + toLower(pkg.name)})
ON CREATE SET pn.name = pkg.name
MERGE (source)-[r:REFERENCES_PACKAGE]->(pn)
SET r.version = pkg.version, r.sdkStyle = $sdkStyle
'@ @{ sourceId = $entityId; pkgs = $pkgRefs; sdkStyle = $sdkStyle } | Out-Null
            $totalPkgRefs += $pkgRefs.Count
        } catch {
            Write-Host ("  WARN: PackageRefs failed for {0}: {1}" -f $projRelDir, $_) -ForegroundColor Yellow
            $failed++
        }
    }

    if (($processed % 25) -eq 0) {
        Write-Host ("  ... {0}/{1} processed" -f $processed, $csprojFiles.Count) -ForegroundColor DarkGray
    }
}

# ---- Verify -------------------------------------------------------------------
Write-Host ""
if ($DryRun) {
    Write-Host ("Dry run complete. Would write: {0} REFERENCES_PROJECT, {1} REFERENCES_PACKAGE edges" -f $totalProjRefs, $totalPkgRefs) -ForegroundColor Yellow
} else {
    Write-Host ("Repair complete. Wrote: {0} REFERENCES_PROJECT, {1} REFERENCES_PACKAGE edges across {2} projects ({3} failures)" -f $totalProjRefs, $totalPkgRefs, $processed, $failed) -ForegroundColor Green

    Write-Host ""
    Write-Host "Verifying in Neo4j..." -ForegroundColor Cyan
    $r1 = Invoke-Cypher @'
MATCH ()-[r:REFERENCES_PROJECT]->() RETURN count(r) AS cnt
'@ $null
    $r2 = Invoke-Cypher @'
MATCH ()-[r:REFERENCES_PACKAGE]->() RETURN count(r) AS cnt
'@ $null
    $r3 = Invoke-Cypher @'
MATCH (pn:PackageNode) RETURN count(pn) AS cnt
'@ $null
    Write-Host ("  REFERENCES_PROJECT  : {0,6}" -f $r1.data[0].row[0])
    Write-Host ("  REFERENCES_PACKAGE  : {0,6}" -f $r2.data[0].row[0])
    Write-Host ("  PackageNode nodes   : {0,6}" -f $r3.data[0].row[0])
}
Write-Host ""
