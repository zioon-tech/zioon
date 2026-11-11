$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Install Node.js >=22.5 with npm first: https://nodejs.org/"
}
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<5))process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw "Node.js >=22.5 is required." }
$zioonPrefix = if ($env:ZIOON_INSTALL_PREFIX) { $env:ZIOON_INSTALL_PREFIX } else { Join-Path $env:LOCALAPPDATA "Zioon\cli" }
npm install --global --prefix $zioonPrefix --ignore-scripts https://zioon.tech/downloads/zioon-cli-0.3.0.tgz
if ($LASTEXITCODE -ne 0) { throw "CLI installation failed." }
& (Join-Path $zioonPrefix "zioon.cmd") --version
if ($LASTEXITCODE -ne 0) { throw "CLI verification failed." }
Write-Host "Installed Zioon CLI. Add $zioonPrefix to your user PATH."
Write-Host "Next: zioon auth login zioon-cloud"
