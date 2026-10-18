[CmdletBinding()]
param(
  [string]$Profile = 'belorella',
  [string]$Region = 'ap-southeast-2',
  [string]$ParameterName = '/belorella/prod/env',
  [string]$AdditionalClientOrigin = '',
  [switch]$ConfirmAllProviderSecretsRotated
)

$ErrorActionPreference = 'Stop'
$BackendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$EnvPath = Join-Path $BackendRoot '.env'
$AwsCli = Join-Path $env:ProgramFiles 'Amazon\AWSCLIV2\aws.exe'
if (-not (Test-Path -LiteralPath $AwsCli)) {
  $AwsCli = 'C:\Users\raiha\AppData\Local\Programs\Amazon\AWSCLIV2\aws.exe'
}
if (-not (Test-Path -LiteralPath $EnvPath)) { throw 'Backend .env file is missing.' }
if (-not (Test-Path -LiteralPath $AwsCli)) { throw 'AWS CLI v2 was not found.' }
if (-not $ConfirmAllProviderSecretsRotated) {
  throw 'Rotate the credentials previously exposed in chat, update .env, then rerun with -ConfirmAllProviderSecretsRotated.'
}

$secureDirectory = Join-Path $env:TEMP ("belorella-ssm-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $secureDirectory | Out-Null
$acl = Get-Acl -LiteralPath $secureDirectory
$acl.SetAccessRuleProtection($true, $false)
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $secureDirectory -AclObject $acl

$inputPath = Join-Path $secureDirectory 'put-parameter.json'
$generatorPath = Join-Path $secureDirectory 'generate-input.js'
$generator = @'
const fs = require('fs');
const path = require('path');
const dotenv = require(path.join(process.argv[2], 'node_modules', 'dotenv'));
const source = dotenv.parse(fs.readFileSync(path.join(process.argv[2], '.env')));
const required = ['DATABASE_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'EMAIL_USER', 'EMAIL_PASSWORD', 'CLIENT_URL', 'SITE_URL'];
const missing = required.filter((name) => !String(source[name] || '').trim());
if (missing.length) throw new Error(`Missing required production settings: ${missing.join(', ')}`);
if (process.argv[4]) {
  const origins = String(source.CLIENT_URL).split(',').map((origin) => origin.trim()).filter(Boolean);
  if (!origins.includes(process.argv[4])) origins.push(process.argv[4]);
  source.CLIENT_URL = origins.join(',');
}
source.TRUST_PROXY_HOPS = '2';
const payload = {
  Name: process.argv[3],
  Type: 'SecureString',
  Description: 'BELORELLA production backend environment',
  Overwrite: true,
  Value: JSON.stringify(source),
};
fs.writeFileSync(process.argv[5], JSON.stringify(payload), { mode: 0o600 });
'@

try {
  Set-Content -LiteralPath $generatorPath -Value $generator -NoNewline -Encoding UTF8
  & node $generatorPath $BackendRoot $ParameterName $AdditionalClientOrigin $inputPath
  if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the protected SSM input. Check required .env keys.' }
  $inputAcl = Get-Acl -LiteralPath $inputPath
  $inputAcl.SetAccessRuleProtection($true, $false)
  $inputAcl.SetAccessRule($rule)
  Set-Acl -LiteralPath $inputPath -AclObject $inputAcl
  & $AwsCli ssm put-parameter --profile $Profile --region $Region --cli-input-json "file://$($inputPath.Replace('\','/'))" --query 'Version' --output text
  if ($LASTEXITCODE -ne 0) { throw 'AWS did not accept the SecureString parameter.' }
  Write-Output "Updated $ParameterName in $Region. Secret values were not printed."
} finally {
  if (Test-Path -LiteralPath $secureDirectory) { Remove-Item -LiteralPath $secureDirectory -Recurse -Force }
}
