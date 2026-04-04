# enrich-project-nodes.ps1
# Creates :Project nodes in the Neo4j CodeGraph and links every :File node
# to its project via a BELONGS_TO_PROJECT relationship.
#
# Safe to re-run -- all writes use MERGE, so existing nodes/relationships are
# only updated, never duplicated.
#
# The inventory CSV is expected to have at minimum these columns:
#   FileName   - e.g. MyProject.csproj
#   Directory  - e.g. MyRepo\Src\Core\MyProject   (relative path from repo root)
#   Section    - e.g. Core  (optional; used to group projects)
#
# Usage:
#   .\scripts\enrich-project-nodes.ps1 -InventoryCsv ".\project-inventory.csv"
#   .\scripts\enrich-project-nodes.ps1 -InventoryCsv ".\project-inventory.csv" -SrcFilter "\Src\"

param(
    [Parameter(Mandatory)]
    [string]$InventoryCsv,

    [string]$Neo4jUri  = "http://localhost:7474/db/codegraph/tx/commit",
    [string]$Neo4jUser = "neo4j",
    [string]$Neo4jPass = "neo4j",

    # Optional: only include rows whose Directory contains this substring
    # e.g. "\Src\" to skip test projects outside the production source tree
    [string]$SrcFilter = ""
)

# ---- Neo4j REST helpers ------------------------------------------------------
$cred    = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${Neo4jUser}:${Neo4jPass}"))
$headers = @{
    'Content-Type'  = 'application/json'
    'Accept'        = 'application/json'
    'Authorization' = 'Basic ' + $cred
}

function Invoke-Cypher {
    param([string]$Query, [hashtable]$Parameters = @{})
    $stmt = @{ statement = $Query }
    if ($Parameters.Count -gt 0) { $stmt['parameters'] = $Parameters }
    $body = ConvertTo-Json @{ statements = @($stmt) } -Depth 8 -Compress
    $response = Invoke-RestMethod -Uri $Neo4jUri -Method Post -Headers $headers -Body $body
    if ($response.errors -and $response.errors.Count -gt 0) {
        $err = $response.errors[0]
        throw ("Cypher error [{0}]: {1}" -f $err.code, $err.message)
    }
    return $response.results[0]
}

# ---- Load project inventory --------------------------------------------------
if (-not (Test-Path $InventoryCsv)) {
    Write-Error ("Inventory CSV not found at: {0}" -f $InventoryCsv)
    exit 1
}

# Get-Content -Encoding UTF8 strips the UTF-8 BOM that PowerShell's Export-Csv writes.
$rows = Get-Content -Path $InventoryCsv -Encoding UTF8 | ConvertFrom-Csv

# Optionally filter rows by directory substring (e.g. production src tree only)
if ($SrcFilter) {
    $rows = $rows | Where-Object { $_.Directory -like "*$SrcFilter*" }
}

Write-Host ""
Write-Host ("  enrich-project-nodes: {0} projects from inventory" -f $rows.Count) -ForegroundColor Cyan

# ---- Build batch data --------------------------------------------------------
$now   = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
$batch = @()

foreach ($row in $rows) {
    $name     = [System.IO.Path]::GetFileNameWithoutExtension($row.FileName)
    # entityId includes relPath so same-named projects in different folders stay distinct
    $entityId = "Project:" + $row.Directory.Replace('\', '/')

    # Try to extract section from a "Section" column if present; otherwise parse from path
    $section = if ($row.PSObject.Properties['Section'] -and $row.Section) {
        $row.Section
    } else {
        $parts = $row.Directory -split '\\'
        if ($parts.Count -gt 2) { $parts[2] } else { "Unknown" }
    }

    # Normalize path separators for consistent CONTAINS matching against filePath
    $relPath     = $row.Directory.Replace('\', '/')
    # Trailing slash prevents "MyProject" from matching "MyProject.Tests"
    $pathSegment = $relPath + '/'

    $batch += @{
        entityId    = $entityId
        name        = $name
        section     = $section
        relPath     = $relPath
        pathSegment = $pathSegment
        createdAt   = $now
    }
}

# ---- Step 1: Ensure uniqueness constraint ------------------------------------
Write-Host "  Step 1/4 - ensuring Project node uniqueness constraint..." -ForegroundColor DarkGray
Invoke-Cypher @'
CREATE CONSTRAINT project_entityid_unique IF NOT EXISTS
FOR (p:Project) REQUIRE p.entityId IS UNIQUE
'@ | Out-Null

# ---- Step 2: MERGE Project nodes ---------------------------------------------
Write-Host ("  Step 2/4 - merging {0} Project nodes..." -f $batch.Count) -ForegroundColor DarkGray

$nodeResult = Invoke-Cypher -Query @'
UNWIND $batch AS proj
MERGE (p:Project {entityId: proj.entityId})
SET p.name      = proj.name,
    p.section   = proj.section,
    p.relPath   = proj.relPath,
    p.createdAt = proj.createdAt
RETURN count(p) AS projectCount
'@ -Parameters @{ batch = $batch }

$projectCount = if ($nodeResult.data -and $nodeResult.data.Count -gt 0) { $nodeResult.data[0].row[0] } else { 0 }
Write-Host ("    Project nodes merged: {0}" -f $projectCount) -ForegroundColor Green

# ---- Step 3: MERGE BELONGS_TO_PROJECT relationships -------------------------
Write-Host "  Step 3/4 - linking File nodes to Projects..." -ForegroundColor DarkGray

$relResult = Invoke-Cypher -Query @'
UNWIND $batch AS proj
MATCH (f:File)
WHERE f.filePath CONTAINS proj.pathSegment
MATCH (p:Project {entityId: proj.entityId})
MERGE (f)-[:BELONGS_TO_PROJECT]->(p)
RETURN count(*) AS linkedFiles
'@ -Parameters @{ batch = $batch }

$linkedFiles = if ($relResult.data -and $relResult.data.Count -gt 0) { $relResult.data[0].row[0] } else { 0 }
Write-Host ("    File nodes linked   : {0}" -f $linkedFiles) -ForegroundColor Green

# ---- Step 4: Backfill missing File->DEFINES_CLASS edges ----------------------
# The AST analyzer creates DEFINES_CLASS from NamespaceDeclaration for most classes
# but File-sourced edges may be missing. This backfill uses CSharpClass.filePath
# to create the direct File->DEFINES_CLASS link where it is absent.
Write-Host "  Step 4/4 - backfilling missing File->DEFINES_CLASS edges..." -ForegroundColor DarkGray

$dcResult = Invoke-Cypher @'
MATCH (c:CSharpClass)
WHERE c.filePath IS NOT NULL AND NOT (:File)-[:DEFINES_CLASS]->(c)
MATCH (f:File {filePath: c.filePath})
MERGE (f)-[:DEFINES_CLASS]->(c)
RETURN count(*) AS created
'@

$dcCreated = if ($dcResult.data -and $dcResult.data.Count -gt 0) { $dcResult.data[0].row[0] } else { 0 }
Write-Host ("    DEFINES_CLASS edges created: {0}" -f $dcCreated) -ForegroundColor Green

$dcTotal = Invoke-Cypher @'
MATCH (f:File)-[:DEFINES_CLASS]->(c:CSharpClass) RETURN count(*) AS total
'@
$dcTotalCount = if ($dcTotal.data -and $dcTotal.data.Count -gt 0) { $dcTotal.data[0].row[0] } else { 0 }
Write-Host ("    DEFINES_CLASS total  : {0}" -f $dcTotalCount) -ForegroundColor Green

# ---- Summary -----------------------------------------------------------------
Write-Host ""
Write-Host ("  Enrichment complete: {0} projects, {1} files linked, {2} DEFINES_CLASS edges backfilled." -f $projectCount, $linkedFiles, $dcCreated) -ForegroundColor Cyan
Write-Host ""
