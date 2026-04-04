# neo4j-manage.ps1 - Manage the CodeGraph Neo4j Podman container
# Usage: .\scripts\neo4j-manage.ps1 [start|stop|restart|status|logs|info]
#
# Prerequisites (any machine):
#   - Podman installed and running (Windows: Podman Desktop with WSL2 provider)
#   - Internet access on first 'start' — NEO4J_PLUGINS downloads APOC automatically
#   - To restore a backup: run 'start' first, then restore the codegraph database
#     using: podman exec <container> neo4j-admin database restore ...
#
# The database is NOT stored in the image — it lives in the named volume and
# must be restored separately after a fresh container creation.

param(
    [Parameter(Position=0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs', 'info')]
    [string]$Command = 'status',

    [string]$ContainerName = "codegraph-neo4j",
    [string]$Image         = "neo4j:2025.01.0",
    [string]$Database      = "codegraph",
    [string]$Password      = "neo4j"
)

$BOLT_URI = "bolt://localhost:7687"
$BROWSER  = "http://localhost:7474"
$USERNAME = "neo4j"

function Show-Info {
    Write-Host ""
    Write-Host "Neo4j CodeGraph Connection Info" -ForegroundColor Cyan
    Write-Host "================================" -ForegroundColor Cyan
    Write-Host "  Bolt URI  : $BOLT_URI"
    Write-Host "  Browser   : $BROWSER"
    Write-Host "  Username  : $USERNAME"
    Write-Host "  Database  : $Database"
    Write-Host "  Container : $ContainerName"
    Write-Host "  Image     : $Image"
    Write-Host ""
}

function Start-Container {
    $existing = podman ps -a --filter "name=$ContainerName" --format "{{.Names}}" 2>$null
    if ($existing -eq $ContainerName) {
        $running = podman ps --filter "name=$ContainerName" --format "{{.Names}}" 2>$null
        if ($running -eq $ContainerName) {
            Write-Host "Container '$ContainerName' is already running." -ForegroundColor Yellow
        } else {
            Write-Host "Starting existing container '$ContainerName'..." -ForegroundColor Green
            podman start $ContainerName
        }
    } else {
        Write-Host "Creating and starting '$ContainerName' from $Image..." -ForegroundColor Green
        Write-Host "(APOC will be downloaded on first startup — requires internet access)" -ForegroundColor DarkGray
        podman run -d `
            --name $ContainerName `
            -p 7474:7474 `
            -p 7687:7687 `
            -e NEO4J_AUTH="neo4j/$Password" `
            -e NEO4J_initial_dbms_default__database=$Database `
            -e NEO4J_dbms_default__database=$Database `
            -e 'NEO4J_PLUGINS=["apoc"]' `
            -e NEO4J_dbms_security_procedures_unrestricted="apoc.*" `
            -e NEO4J_dbms_security_procedures_allowlist="apoc.*" `
            -v "${ContainerName}-data:/data" `
            -v "${ContainerName}-logs:/logs" `
            --restart unless-stopped `
            $Image
        Write-Host "Waiting 20s for Neo4j and APOC to initialize..." -ForegroundColor DarkGray
        Start-Sleep -Seconds 20
        Write-Host "Container '$ContainerName' ready." -ForegroundColor Green
    }
    Show-Info
}

switch ($Command) {
    'start' {
        Start-Container
    }
    'stop' {
        Write-Host "Stopping '$ContainerName'..." -ForegroundColor Yellow
        podman stop $ContainerName
    }
    'restart' {
        # 'podman restart' can fail with port-already-in-use; stop then start is reliable
        Write-Host "Restarting '$ContainerName'..." -ForegroundColor Yellow
        podman stop $ContainerName
        Start-Sleep -Seconds 3
        Start-Container
    }
    'status' {
        $status = podman ps -a --filter "name=$ContainerName" --format "table {{.Names}}`t{{.Status}}`t{{.Ports}}"
        if ($status) {
            Write-Host $status
        } else {
            Write-Host "Container '$ContainerName' not found." -ForegroundColor Red
        }
    }
    'logs' {
        podman logs --tail 50 $ContainerName
    }
    'info' {
        Show-Info
    }
}
