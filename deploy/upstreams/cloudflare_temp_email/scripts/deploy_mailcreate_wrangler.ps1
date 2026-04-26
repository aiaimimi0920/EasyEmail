param(
    [ValidateSet('full', 'bootstrap', 'build-frontend', 'deploy-worker', 'deploy-pages', 'd1-remote-init', 'd1-local-init', 'check', 'secret-put')]
    [string]$Action = 'full',

    [string]$ProjectRoot = '',
    [string]$WorkerName = 'cloudflare_temp_email',
    [string]$D1DatabaseName = 'cloudflare-temp-email',
    [string]$FrontendProjectName = '',
    [string]$TelegramFrontendProjectName = '',
    [string]$WorkerEnv = 'production',
    [string]$PagesBranch = 'production',
    [string]$SecretName = '',
    [switch]$Telegram,
    [switch]$SkipFrontendBuild,
    [switch]$UsePagesFunctionFrontend,
    [switch]$Remote,
    [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step {
    param([string]$Message)
    Write-Host "`n==== $Message ====" -ForegroundColor Cyan
}

function Resolve-Tool {
    param([string]$CommandName)

    $cmd = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }

    if ($CommandName -eq 'pnpm') {
        $corepack = Get-Command 'corepack' -ErrorAction SilentlyContinue
        if ($corepack) {
            return $corepack.Source
        }

        $npm = Get-Command 'npm' -ErrorAction SilentlyContinue
        if ($npm) {
            return $npm.Source
        }
    }

    if ($CommandName -eq 'npx') {
        $npm = Get-Command 'npm' -ErrorAction SilentlyContinue
        if ($npm) {
            return $npm.Source
        }
    }

    throw "未找到命令: $CommandName。请先安装后再执行。"
}

function Get-CommandArguments {
    param(
        [string]$CommandName,
        [string[]]$Arguments
    )

    $cmd = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($cmd) {
        return ,$Arguments
    }

    if ($CommandName -eq 'pnpm') {
        $corepack = Get-Command 'corepack' -ErrorAction SilentlyContinue
        if ($corepack) {
            return ,(@('pnpm') + $Arguments)
        }

        $npm = Get-Command 'npm' -ErrorAction SilentlyContinue
        if ($npm) {
            return ,(@('exec', '--', 'pnpm') + $Arguments)
        }
    }

    if ($CommandName -eq 'npx') {
        $npm = Get-Command 'npm' -ErrorAction SilentlyContinue
        if ($npm) {
            return ,(@('exec', '--') + $Arguments)
        }
    }

    return ,$Arguments
}

function Invoke-LoggedCommand {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )

    $argLine = if ($Arguments -and $Arguments.Count -gt 0) {
        $Arguments -join ' '
    }
    else {
        ''
    }

    Write-Host ("[{0}] {1} {2}" -f $WorkingDirectory, $FilePath, $argLine) -ForegroundColor DarkGray
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "命令执行失败，退出码: $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

function Assert-PathExists {
    param([string]$PathValue, [string]$Label)
    if (-not (Test-Path -LiteralPath $PathValue)) {
        throw "$Label 不存在: $PathValue"
    }
}

function Get-ProjectPaths {
    param([string]$Base)

    $workerDir = Join-Path $Base 'worker'
    $frontendDir = Join-Path $Base 'frontend'
    $pagesDir = Join-Path $Base 'pages'
    $dbDir = Join-Path $Base 'db'

    Assert-PathExists -PathValue $Base -Label '项目根目录'
    Assert-PathExists -PathValue $workerDir -Label 'Worker 目录'
    Assert-PathExists -PathValue $frontendDir -Label 'Frontend 目录'
    Assert-PathExists -PathValue $pagesDir -Label 'Pages 目录'
    Assert-PathExists -PathValue $dbDir -Label '数据库目录'

    return [pscustomobject]@{
        Base = $Base
        Worker = $workerDir
        Frontend = $frontendDir
        Pages = $pagesDir
        Db = $dbDir
        WorkerWrangler = Join-Path $workerDir 'wrangler.toml'
        WorkerWranglerTemplate = Join-Path $workerDir 'wrangler.toml.template'
        WorkerPackageJson = Join-Path $workerDir 'package.json'
        FrontendPackageJson = Join-Path $frontendDir 'package.json'
        PagesPackageJson = Join-Path $pagesDir 'package.json'
        FrontendDist = Join-Path $frontendDir 'dist'
        DbInitSql = Join-Path $dbDir 'init.sql'
    }
}

function Test-WranglerTomlSafety {
    param([string]$WranglerToml)

    Assert-PathExists -PathValue $WranglerToml -Label 'wrangler.toml'
    $content = Get-Content -LiteralPath $WranglerToml -Raw -Encoding UTF8

    if ($content -match 'CHANGE_ME') {
        Write-Warning '检测到 wrangler.toml 中仍包含 CHANGE_ME，请在 deploy 前确认 JWT_SECRET 等配置已替换为真实值或改用 secret。'
    }

    if ($content -match 'database_id\s*=\s*""') {
        Write-Warning '检测到 D1 database_id 为空，首次部署前请先创建 D1 并更新 wrangler.toml。'
    }
}

function Install-Dependencies {
    param([pscustomobject]$Paths)

    $pnpm = Resolve-Tool 'pnpm'

    Write-Step '安装 Worker 依赖'
    Invoke-LoggedCommand -FilePath $pnpm -Arguments (Get-CommandArguments -CommandName 'pnpm' -Arguments @('install', '--no-frozen-lockfile')) -WorkingDirectory $Paths.Worker

    Write-Step '安装 Frontend 依赖'
    Invoke-LoggedCommand -FilePath $pnpm -Arguments (Get-CommandArguments -CommandName 'pnpm' -Arguments @('install', '--no-frozen-lockfile')) -WorkingDirectory $Paths.Frontend

    Write-Step '安装 Pages 依赖'
    Invoke-LoggedCommand -FilePath $pnpm -Arguments (Get-CommandArguments -CommandName 'pnpm' -Arguments @('install', '--no-frozen-lockfile')) -WorkingDirectory $Paths.Pages
}

function Build-Frontend {
    param([pscustomobject]$Paths, [switch]$TelegramMode)

    $pnpm = Resolve-Tool 'pnpm'
    $script = if ($TelegramMode) { 'build:telegram:pages' } else { 'build:pages' }

    Write-Step "构建 Frontend ($script)"
    Invoke-LoggedCommand -FilePath $pnpm -Arguments (Get-CommandArguments -CommandName 'pnpm' -Arguments @('run', $script)) -WorkingDirectory $Paths.Frontend

    if (-not (Test-Path -LiteralPath $Paths.FrontendDist)) {
        throw "前端构建完成后未找到 dist 目录: $($Paths.FrontendDist)"
    }
}

function Deploy-Worker {
    param([pscustomobject]$Paths, [string]$EnvName)

    $pnpm = Resolve-Tool 'pnpm'
    Test-WranglerTomlSafety -WranglerToml $Paths.WorkerWrangler

    Write-Step '部署 Worker'
    $args = @('run', 'deploy')
    if ($EnvName -and $EnvName -ne 'production') {
        $args += '--'
        $args += '--env'
        $args += $EnvName
    }
    Invoke-LoggedCommand -FilePath $pnpm -Arguments (Get-CommandArguments -CommandName 'pnpm' -Arguments $args) -WorkingDirectory $Paths.Worker
}

function Deploy-PagesFunctionFrontend {
    param([pscustomobject]$Paths, [string]$BranchName)

    $pnpm = Resolve-Tool 'pnpm'

    Write-Step '构建前端供 Pages Functions 使用'
    Invoke-LoggedCommand -FilePath $pnpm -Arguments (Get-CommandArguments -CommandName 'pnpm' -Arguments @('run', 'build:pages')) -WorkingDirectory $Paths.Frontend

    Write-Step '部署 Pages Functions'
    $args = @('run', 'deploy', '--', '--branch', $BranchName)
    Invoke-LoggedCommand -FilePath $pnpm -Arguments (Get-CommandArguments -CommandName 'pnpm' -Arguments $args) -WorkingDirectory $Paths.Pages
}

function Deploy-StaticPagesFrontend {
    param(
        [pscustomobject]$Paths,
        [string]$ProjectName,
        [string]$BranchName,
        [switch]$TelegramMode
    )

    if ([string]::IsNullOrWhiteSpace($ProjectName)) {
        throw '未提供 FrontendProjectName，无法部署静态 Pages。'
    }

    $pnpm = Resolve-Tool 'pnpm'
    $script = if ($TelegramMode) { 'deploy:actions:telegram' } else { 'deploy:actions' }

    Write-Step "部署静态 Pages Frontend ($ProjectName)"
    Invoke-LoggedCommand -FilePath $pnpm -Arguments (Get-CommandArguments -CommandName 'pnpm' -Arguments @('run', $script, '--project-name', $ProjectName, '--branch', $BranchName)) -WorkingDirectory $Paths.Frontend
}

function Initialize-D1 {
    param(
        [pscustomobject]$Paths,
        [string]$DatabaseName,
        [switch]$RemoteMode
    )

    Assert-PathExists -PathValue $Paths.DbInitSql -Label 'D1 初始化 SQL'
    $npx = Resolve-Tool 'npx'

    Write-Step '执行 D1 初始化 SQL'
    $args = @('wrangler', 'd1', 'execute', $DatabaseName)
    if ($RemoteMode) {
        $args += '--remote'
    }
    $args += '--file'
    $args += $Paths.DbInitSql

    Invoke-LoggedCommand -FilePath $npx -Arguments (Get-CommandArguments -CommandName 'npx' -Arguments $args) -WorkingDirectory $Paths.Worker
}

function Put-Secret {
    param(
        [pscustomobject]$Paths,
        [string]$Name,
        [string]$EnvName
    )

    if ([string]::IsNullOrWhiteSpace($Name)) {
        throw 'Action=secret-put 时必须传入 -SecretName。'
    }

    $npx = Resolve-Tool 'npx'

    Write-Step "写入 Worker Secret: $Name"
    $args = @('wrangler', 'secret', 'put', $Name)
    if ($EnvName -and $EnvName -ne 'production') {
        $args += '--env'
        $args += $EnvName
    }

    Invoke-LoggedCommand -FilePath $npx -Arguments (Get-CommandArguments -CommandName 'npx' -Arguments $args) -WorkingDirectory $Paths.Worker
}

function Run-Check {
    param([pscustomobject]$Paths)

    Write-Step '检查项目结构'
    $checks = @(
        $Paths.WorkerPackageJson,
        $Paths.FrontendPackageJson,
        $Paths.PagesPackageJson,
        $Paths.WorkerWrangler,
        $Paths.DbInitSql
    )

    foreach ($item in $checks) {
        if (-not (Test-Path -LiteralPath $item)) {
            throw "缺少必要文件: $item"
        }
        Write-Host "OK: $item" -ForegroundColor Green
    }

    Test-WranglerTomlSafety -WranglerToml $Paths.WorkerWrangler

    Write-Host ''
    Write-Host '标准部署建议顺序：' -ForegroundColor Yellow
    Write-Host '1. bootstrap           安装依赖'
    Write-Host '2. d1-remote-init      初始化远端 D1（首次或变更 schema 时）'
    Write-Host '3. deploy-worker       部署 Worker（可附带前端 assets）'
    Write-Host '4. deploy-pages        如你仍使用独立 Pages 前端/Pages Functions，再执行此步骤'
}

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../../upstreams/cloudflare_temp_email')).Path
}

$paths = Get-ProjectPaths -Base $ProjectRoot

switch ($Action) {
    'bootstrap' {
        Install-Dependencies -Paths $paths
    }
    'build-frontend' {
        if (-not $NoInstall) {
            Install-Dependencies -Paths $paths
        }
        Build-Frontend -Paths $paths -TelegramMode:$Telegram
    }
    'deploy-worker' {
        if (-not $NoInstall) {
            Install-Dependencies -Paths $paths
        }
        if (-not $SkipFrontendBuild) {
            Build-Frontend -Paths $paths -TelegramMode:$Telegram
        }
        Deploy-Worker -Paths $paths -EnvName $WorkerEnv
    }
    'deploy-pages' {
        if (-not $NoInstall) {
            Install-Dependencies -Paths $paths
        }
        if ($UsePagesFunctionFrontend) {
            Deploy-PagesFunctionFrontend -Paths $paths -BranchName $PagesBranch
        }
        else {
            $projectName = if ($Telegram) { $TelegramFrontendProjectName } else { $FrontendProjectName }
            Deploy-StaticPagesFrontend -Paths $paths -ProjectName $projectName -BranchName $PagesBranch -TelegramMode:$Telegram
        }
    }
    'd1-remote-init' {
        Initialize-D1 -Paths $paths -DatabaseName $D1DatabaseName -RemoteMode:$true
    }
    'd1-local-init' {
        Initialize-D1 -Paths $paths -DatabaseName $D1DatabaseName -RemoteMode:$false
    }
    'check' {
        Run-Check -Paths $paths
    }
    'secret-put' {
        Put-Secret -Paths $paths -Name $SecretName -EnvName $WorkerEnv
    }
    'full' {
        if (-not $NoInstall) {
            Install-Dependencies -Paths $paths
        }
        if (-not $SkipFrontendBuild) {
            Build-Frontend -Paths $paths -TelegramMode:$Telegram
        }
        Deploy-Worker -Paths $paths -EnvName $WorkerEnv
    }
    default {
        throw "不支持的 Action: $Action"
    }
}

Write-Host "`n完成: Action=$Action" -ForegroundColor Green

