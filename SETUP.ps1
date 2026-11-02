# ============================================================================
# Yahoo! Security Messenger - Automated Setup Script
# ============================================================================
# This script automates the complete setup process:
# 1. Navigate to client directory
# 2. Clean cache
# 3. Install dependencies
# 4. Start dev server
# 5. Open browser
# ============================================================================

Write-Host "🚀 Yahoo! Security Messenger - Setup Starting..." -ForegroundColor Cyan
Write-Host ""

# Step 1: Navigate to client directory
Write-Host "📁 Step 1: Navigating to client directory..." -ForegroundColor Yellow
cd D:\Projects\SecuBuzz-\client
$clientDir = Get-Location
Write-Host "✅ Current directory: $clientDir" -ForegroundColor Green
Write-Host ""

# Step 2: Check Node and npm versions
Write-Host "🔍 Step 2: Checking Node.js and npm..." -ForegroundColor Yellow
$nodeVersion = node --version
$npmVersion = npm --version
Write-Host "✅ Node.js version: $nodeVersion" -ForegroundColor Green
Write-Host "✅ npm version: $npmVersion" -ForegroundColor Green
Write-Host ""

# Step 3: Clear npm cache
Write-Host "🧹 Step 3: Clearing npm cache..." -ForegroundColor Yellow
npm cache clean --force | Out-Null
Write-Host "✅ Cache cleared" -ForegroundColor Green
Write-Host ""

# Step 4: Install dependencies
Write-Host "📦 Step 4: Installing dependencies (this may take 3-10 minutes)..." -ForegroundColor Yellow
Write-Host "⏳ Downloading packages from npm registry..." -ForegroundColor Cyan
Write-Host ""

# Show initial count
$initialCount = (Get-ChildItem node_modules -Directory -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host "Initial packages: $initialCount" -ForegroundColor Cyan

# Run npm install with timeout handling
$npmInstallProc = Start-Process npm -ArgumentList "install --prefer-offline --legacy-peer-deps" -NoNewWindow -PassThru
$timeout = 0
$maxTimeout = 600  # 10 minutes

while (!$npmInstallProc.HasExited -and $timeout -lt $maxTimeout) {
    Start-Sleep -Seconds 10
    $timeout += 10
    $currentCount = (Get-ChildItem node_modules -Directory -ErrorAction SilentlyContinue | Measure-Object).Count
    $percent = if ($currentCount -gt 0) { [math]::Min(($currentCount / 50) * 100, 100) } else { 0 }
    Write-Host "⏳ Progress: $currentCount packages (~$([math]::Round($percent))%) - ${timeout}s elapsed"
}

if ($npmInstallProc.HasExited) {
    $finalCount = (Get-ChildItem node_modules -Directory -ErrorAction SilentlyContinue | Measure-Object).Count
    Write-Host "✅ Installation complete! ($finalCount packages installed)" -ForegroundColor Green
} else {
    Write-Host "⚠️  Installation still running after 10 minutes. Continuing anyway..." -ForegroundColor Yellow
    $npmInstallProc | Stop-Process -Force
}

Write-Host ""

# Step 5: Verify installation
Write-Host "✔️ Step 5: Verifying installation..." -ForegroundColor Yellow
$packageCount = (Get-ChildItem node_modules -Directory -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host "✅ Packages installed: $packageCount" -ForegroundColor Green

if ((Test-Path "node_modules\next") -and (Test-Path "node_modules\react")) {
    Write-Host "✅ Key dependencies verified (Next.js, React)" -ForegroundColor Green
} else {
    Write-Host "⚠️  Some dependencies may still be installing..." -ForegroundColor Yellow
}

Write-Host ""

# Step 6: Start dev server
Write-Host "🚀 Step 6: Starting development server..." -ForegroundColor Yellow
Write-Host "⏳ Starting Next.js on http://localhost:3000" -ForegroundColor Cyan
Write-Host ""
Write-Host "Waiting for server to be ready..." -ForegroundColor Gray

# Give server time to start
Start-Sleep -Seconds 2

# Start dev server in a new window (so user can see it running)
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd D:\Projects\SecuBuzz-\client; npm run dev"

# Wait a bit for server to start
Start-Sleep -Seconds 5

# Step 7: Open browser
Write-Host "🌐 Step 7: Opening browser..." -ForegroundColor Yellow
try {
    Start-Process "http://localhost:3000"
    Write-Host "✅ Browser opened to http://localhost:3000" -ForegroundColor Green
} catch {
    Write-Host "ℹ️  Please open http://localhost:3000 manually in your browser" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "================================" -ForegroundColor Cyan
Write-Host "✨ Setup Complete!" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "🎮 Your application is running at:" -ForegroundColor Green
Write-Host "   http://localhost:3000" -ForegroundColor Cyan
Write-Host ""
Write-Host "📝 Try these features:" -ForegroundColor Green
Write-Host "   • Type a message in the input box" -ForegroundColor White
Write-Host "   • Press Enter to send (or Shift+Enter for newline)" -ForegroundColor White
Write-Host "   • Click BUZZ! button to test alert" -ForegroundColor White
Write-Host "   • Messages are encrypted with AES-256-GCM" -ForegroundColor White
Write-Host ""
Write-Host "🧪 Available commands in the development window:" -ForegroundColor Green
Write-Host "   • Ctrl+C: Stop dev server" -ForegroundColor White
Write-Host "   • npm run test: Run tests" -ForegroundColor White
Write-Host "   • npm run type-check: Check TypeScript" -ForegroundColor White
Write-Host ""
Write-Host "📚 Documentation:" -ForegroundColor Green
Write-Host "   • README.md: Project overview" -ForegroundColor White
Write-Host "   • client/DEVELOPMENT.md: Frontend guide" -ForegroundColor White
Write-Host "   • INSTALLATION_GUIDE.md: Setup instructions" -ForegroundColor White
Write-Host ""
Write-Host "================================" -ForegroundColor Cyan
