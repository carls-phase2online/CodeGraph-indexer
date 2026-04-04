# post-process.ps1
# Phase C post-processing for the CodeGraph database.
# Run ONCE after a full --reset-db analysis pass to:
#   1. Create EXTENDS edges   (CSharpClass -> CSharpClass via baseClassName property)
#   2. Create IMPLEMENTS edges (CSharpClass -> CSharpInterface via implementedInterfaces[] property)
#   3. Add usedNamespaces[] to each CSharpClass (aggregated from its file's UsingDirectives)
#
# Usage:
#   .\scripts\post-process.ps1
#   .\scripts\post-process.ps1 -SkipExtends -SkipImplements

param(
    [string]$Neo4jUrl      = "http://localhost:7474/db/codegraph/tx/commit",
    [string]$Neo4jUser     = "neo4j",
    [string]$Neo4jPassword = "neo4j",
    [switch]$SkipExtends,
    [switch]$SkipImplements,
    [switch]$SkipUsedNamespaces
)

$authToken = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${Neo4jUser}:${Neo4jPassword}"))
$headers = @{
    "Content-Type"  = "application/json"
    "Authorization" = "Basic $authToken"
}

function Invoke-Cypher {
    param(
        [string]$Cypher,
        [hashtable]$Params = @{},
        [string]$StepName = "Cypher"
    )
    $body = ConvertTo-Json -Depth 10 @{
        statements = @(@{
            statement          = $Cypher
            parameters         = $Params
            includeStats       = $true
        })
    }
    try {
        $resp = Invoke-RestMethod -Uri $Neo4jUrl -Method Post -Headers $headers -Body $body -ErrorAction Stop
    } catch {
        throw "[${StepName}] HTTP error: $_"
    }
    if ($resp.errors -and $resp.errors.Count -gt 0) {
        throw "[${StepName}] Cypher error: $($resp.errors[0].message)"
    }
    return $resp.results[0].stats
}

Write-Host ""
Write-Host "=== CodeGraph Post-Processing ===" -ForegroundColor Cyan
Write-Host "Target: $Neo4jUrl"
Write-Host ""

# ---------------------------------------------------------------------------
# Step 1: EXTENDS edges (CSharpClass -> CSharpClass)
# ---------------------------------------------------------------------------
if (-not $SkipExtends) {
    Write-Host "[1/3] Creating EXTENDS edges via baseClassName properties..." -ForegroundColor Yellow
    $stats = Invoke-Cypher @"
MATCH (child:CSharpClass)
WHERE child.baseClassName IS NOT NULL
  AND child.baseClassName <> ''
MATCH (parent:CSharpClass {name: child.baseClassName})
WHERE child.entityId <> parent.entityId
MERGE (child)-[:EXTENDS]->(parent)
"@ @{} "CreateExtends"
    Write-Host "      Relationships created : $($stats.relationships_created)" -ForegroundColor Green
    Write-Host "      Properties set        : $($stats.properties_set)" -ForegroundColor Green
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Step 2: IMPLEMENTS edges (CSharpClass -> CSharpInterface)
# ---------------------------------------------------------------------------
if (-not $SkipImplements) {
    Write-Host "[2/3] Creating IMPLEMENTS edges via implementedInterfaces[] properties..." -ForegroundColor Yellow
    $stats = Invoke-Cypher @"
MATCH (child:CSharpClass)
WHERE child.implementedInterfaces IS NOT NULL
  AND size(child.implementedInterfaces) > 0
UNWIND child.implementedInterfaces AS ifaceName
MATCH (iface:CSharpInterface {name: ifaceName})
MERGE (child)-[:IMPLEMENTS]->(iface)
"@ @{} "CreateImplements"
    Write-Host "      Relationships created : $($stats.relationships_created)" -ForegroundColor Green
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Step 3: usedNamespaces[] on CSharpClass
# Aggregates UsingDirective names from the containing File onto each class.
# ---------------------------------------------------------------------------
if (-not $SkipUsedNamespaces) {
    Write-Host "[3/3] Enriching CSharpClass.usedNamespaces[] from file-level UsingDirectives..." -ForegroundColor Yellow
    $stats = Invoke-Cypher @"
MATCH (ns:NamespaceDeclaration)-[:DEFINES_CLASS]->(c:CSharpClass)
MATCH (f:File)-[:DECLARES_NAMESPACE]->(ns)
MATCH (f)-[:CSHARP_USING]->(u:UsingDirective)
WITH c, collect(u.name) AS namespaces
SET c.usedNamespaces = namespaces
"@ @{} "UsedNamespaces"
    Write-Host "      Properties set : $($stats.properties_set)" -ForegroundColor Green
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Verification summary
# ---------------------------------------------------------------------------
Write-Host "=== Verification queries ===" -ForegroundColor Cyan
Write-Host "  EXTENDS edges  :  MATCH ()-[:EXTENDS]->()  RETURN count(*)"
Write-Host "  IMPLEMENTS edges: MATCH ()-[:IMPLEMENTS]->() RETURN count(*)"
Write-Host "  usedNamespaces  : MATCH (c:CSharpClass) WHERE c.usedNamespaces IS NOT NULL RETURN count(c)"
Write-Host "  Package deps    : MATCH (p:Project)-[:REFERENCES_PACKAGE]->(pkg) RETURN p.name, pkg.name, pkg.version LIMIT 10"
Write-Host "  Project deps    : MATCH (p:Project)-[:REFERENCES_PROJECT]->(q:Project) RETURN p.name, q.name LIMIT 10"
Write-Host ""
