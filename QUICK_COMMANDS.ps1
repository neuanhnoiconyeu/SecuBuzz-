# Yahoo! Security Messenger - Quick Commands
# Copy and paste these commands into PowerShell as needed

# ============================================================
# 1. CHECK INSTALLATION PROGRESS
# ============================================================

# Count installed packages (when 50+, installation is done!)
(Get-ChildItem "D:\Projects\SecuBuzz-\client\node_modules" -Directory | Measure-Object).Count

# Show first 20 installed packages
Get-ChildItem "D:\Projects\SecuBuzz-\client\node_modules" | Select-Object -First 20 | Select-Object Name


# ============================================================
# 2. NAVIGATE TO PROJECT
# ============================================================

cd D:\Projects\SecuBuzz-\client
pwd  # Shows current directory


# ============================================================
# 3. START DEVELOPMENT SERVER
# ============================================================

# Once npm install completes:
npm run dev

# Or if port 3000 is in use, use different port:
$env:PORT = 3001; npm run dev


# ============================================================
# 4. OPEN IN BROWSER
# ============================================================

# Once dev server is running, open:
# http://localhost:3000


# ============================================================
# 5. RUN TESTS (70+ tests)
# ============================================================

npm run test

# Run specific test file:
npm run test -- crypto.test.ts

# Run tests with coverage:
npm run test -- --coverage


# ============================================================
# 6. TYPE CHECKING (TypeScript)
# ============================================================

npm run type-check


# ============================================================
# 7. LINTING (Code Quality)
# ============================================================

npm run lint


# ============================================================
# 8. BUILD FOR PRODUCTION
# ============================================================

npm run build


# ============================================================
# 9. CLEAN UP AND RETRY INSTALLATION
# ============================================================

# Kill any npm processes
Stop-Process -Name npm -Force -ErrorAction SilentlyContinue
Stop-Process -Name node -Force -ErrorAction SilentlyContinue

# Clear npm cache
npm cache clean --force

# Install fresh
npm install

# Or with specific flags:
npm install --legacy-peer-deps --force


# ============================================================
# 10. MONITOR INSTALLATION
# ============================================================

# Check every 5 seconds:
for ($i = 0; $i -lt 60; $i++) {
    $count = (Get-ChildItem "D:\Projects\SecuBuzz-\client\node_modules" -Directory -ErrorAction SilentlyContinue | Measure-Object).Count
    Write-Host "[$i] Packages installed: $count"
    if ($count -ge 50) {
        Write-Host "✅ Installation complete!"
        break
    }
    Start-Sleep -Seconds 5
}


# ============================================================
# 11. TROUBLESHOOTING
# ============================================================

# Check Node.js version (should be 18+)
node --version

# Check npm version (should be 9+)
npm --version

# Test npm registry connection
Test-NetConnection npmjs.org -Port 443

# List all npm versions installed
npm list

# Find what's using port 3000
netstat -ano | Select-String "3000"

# Kill process on port 3000
Get-Process | Where-Object {$_.Id -eq (Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue).OwningProcess} | Stop-Process -Force


# ============================================================
# 12. PROJECT DIRECTORY STRUCTURE
# ============================================================

# Navigate and explore
cd D:\Projects\SecuBuzz-
dir

# Go to client
cd client
dir

# Show src structure
tree src /F

# List package.json
Get-Content package.json


# ============================================================
# 13. GIT OPERATIONS (if needed)
# ============================================================

# Check git status
cd D:\Projects\SecuBuzz-
git status

# View recent commits
git log --oneline -10

# See what files changed
git diff


# ============================================================
# 14. DOCUMENTATION LINKS
# ============================================================

# Open README
notepad D:\Projects\SecuBuzz-\README.md

# Open development guide
notepad D:\Projects\SecuBuzz-\client\DEVELOPMENT.md

# Open installation guide
notepad D:\Projects\SecuBuzz-\INSTALLATION_GUIDE.md

# Open security specs
notepad D:\Projects\SecuBuzz-\.kiro\specs\security.md


# ============================================================
# HELPFUL SHORTCUTS
# ============================================================

# One-liner to check all (run after npm install completes):
# npm run type-check; npm run lint; npm run test -- --passWithNoTests

# Start dev server and open browser automatically:
# npm run dev; Start-Sleep -Seconds 5; Start-Process "http://localhost:3000"

# Full setup from scratch:
# cd D:\Projects\SecuBuzz-\client; npm cache clean --force; npm install; npm run dev
