param(
  [string]$Port = '8080'
)

$ErrorActionPreference = 'Stop'

if (-not $env:APPS_SCRIPT_URL) { $env:APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwphKlbw76Y89e_kFAsFhOzjlGCVohR0IzXg3pl4infrFquTDrNsfD0WFf46K6pYY5gNQ/exec' }
if (-not $env:APPS_SCRIPT_GET_TOKEN) { $env:APPS_SCRIPT_GET_TOKEN = 'fd458f8e46s45djfdk54dTgDkecfe5f8e4sd4f64ege4458884df564e84D54F46' }
if (-not $env:APPS_SCRIPT_POST_TOKEN) { $env:APPS_SCRIPT_POST_TOKEN = 'local-post-token' }
if (-not $env:CORS_ORIGINS) { $env:CORS_ORIGINS = 'http://localhost:3000' }
$env:PORT = $Port

Write-Host "Starting local API on port $Port"
Write-Host 'Using local defaults for missing env vars. Override in your shell if needed.'

node index.js
