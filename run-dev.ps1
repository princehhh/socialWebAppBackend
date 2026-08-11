Set-Location $PSScriptRoot

if (!(Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Output "Created .env from .env.example"
}

& ".\node_modules\.bin\prisma.cmd" generate --schema ".\prisma\schema.prisma"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& ".\node_modules\.bin\prisma.cmd" db push --schema ".\prisma\schema.prisma"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& ".\node_modules\.bin\tsx.cmd" watch ".\src\server.ts"
