# test-neo4j-query.ps1
# Tests Neo4j connectivity and runs a basic node-count query via HTTP REST API.
#
# Usage:
#   .\scripts\test-neo4j-query.ps1
#   .\scripts\test-neo4j-query.ps1 -Database neo4j -Password mypassword

param(
    [string]$Uri      = "http://localhost:7474",
    [string]$Database = "codegraph",
    [string]$Username = "neo4j",
    [string]$Password = "neo4j"
)

$endpoint = "$Uri/db/$Database/tx/commit"
$headers = @{
    "Authorization" = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${Username}:${Password}"))
    "Content-Type"  = "application/json"
    "Accept"        = "application/json"
}
$body = @{
    statements = @(
        @{
            statement = "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count ORDER BY count DESC LIMIT 10"
        }
    )
} | ConvertTo-Json -Depth 5

try {
    $response = Invoke-RestMethod -Uri $endpoint -Method Post -Headers $headers -Body $body -ErrorAction Stop
    Write-Host "SUCCESS - Query returned results:"
    if ($response.results -and $response.results[0].data) {
        $rows = $response.results[0].data
        Write-Host ("label".PadRight(40) + "count")
        Write-Host ("-" * 50)
        foreach ($row in $rows) {
            $label = if ($null -ne $row.row[0]) { $row.row[0] } else { "(null)" }
            $count = $row.row[1]
            Write-Host ($label.ToString().PadRight(40) + $count.ToString())
        }
    } else {
        Write-Host "No data rows returned."
        Write-Host ($response | ConvertTo-Json -Depth 5)
    }
    if ($response.errors -and $response.errors.Count -gt 0) {
        Write-Host "Errors:"
        Write-Host ($response.errors | ConvertTo-Json -Depth 3)
    }
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host $_.ErrorDetails
}
