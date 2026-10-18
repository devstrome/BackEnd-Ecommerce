[CmdletBinding()]
param(
  [string]$Profile = 'belorella',
  [string]$Region = 'ap-southeast-2',
  [string]$BundlePath = ''
)

$ErrorActionPreference = 'Stop'
$ExpectedRegion = 'ap-southeast-2'
if ($Region -ne $ExpectedRegion) { throw "This workspace is configured for $ExpectedRegion; refusing to provision in $Region." }
if (-not $BundlePath) { throw 'Run prepare-release.ps1 and pass its BundlePath.' }
$BundlePath = (Resolve-Path -LiteralPath $BundlePath).Path
$BackendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$BootstrapPath = Join-Path $PSScriptRoot 'bootstrap-instance.sh'
$AwsCli = Join-Path $env:ProgramFiles 'Amazon\AWSCLIV2\aws.exe'
if (-not (Test-Path -LiteralPath $AwsCli)) { $AwsCli = 'C:\Users\raiha\AppData\Local\Programs\Amazon\AWSCLIV2\aws.exe' }
if (-not (Test-Path -LiteralPath $AwsCli)) { throw 'AWS CLI v2 was not found.' }

$tempFiles = [System.Collections.Generic.List[string]]::new()
function Invoke-Aws([string[]]$Arguments) {
  $result = & $AwsCli @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw (($result | Out-String).Trim()) }
  return $result
}
function Invoke-AwsJson([string[]]$Arguments) {
  $result = Invoke-Aws $Arguments
  return (($result -join "`n") | ConvertFrom-Json)
}
function Write-CliInput($Value) {
  $path = Join-Path $env:TEMP ("belorella-aws-" + [guid]::NewGuid().ToString('N') + '.json')
  $tempFiles.Add($path)
  $json = ConvertTo-Json -InputObject $Value -Depth 40 -Compress
  [System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
  return "file://$($path.Replace('\','/'))"
}
function Get-Query([string[]]$Arguments) {
  return (Invoke-Aws $Arguments | Out-String).Trim()
}

try {
  $accountId = Get-Query @('sts','get-caller-identity','--profile',$Profile,'--query','Account','--output','text')
  $suffix = [guid]::NewGuid().ToString('N').Substring(0,8)
  $bucketPrefix = "belorella-prod-release-$accountId-$Region-".ToLowerInvariant()
  $existingBuckets = Invoke-AwsJson @('s3api','list-buckets','--profile',$Profile)
  $bucket = @($existingBuckets.Buckets | Where-Object { $_.Name.StartsWith($bucketPrefix) } | Select-Object -First 1 | ForEach-Object Name)[0]
  $createdBucket = $false
  if (-not $bucket) { $bucket = "$bucketPrefix$suffix"; $createdBucket = $true }
  $roleName = 'BelorellaProdInstanceRole'
  $profileName = 'BelorellaProdInstanceProfile'
  $securityGroupName = 'BelorellaProdWebOnly'

  if ($createdBucket) { Invoke-Aws @('s3api','create-bucket','--bucket',$bucket,'--region',$Region,'--create-bucket-configuration',"LocationConstraint=$Region",'--profile',$Profile) | Out-Null }
  $publicBlock = Write-CliInput @{ Bucket=$bucket; PublicAccessBlockConfiguration=@{ BlockPublicAcls=$true; IgnorePublicAcls=$true; BlockPublicPolicy=$true; RestrictPublicBuckets=$true } }
  Invoke-Aws @('s3api','put-public-access-block','--cli-input-json',$publicBlock,'--profile',$Profile,'--region',$Region) | Out-Null
  $encryption = Write-CliInput @{ Bucket=$bucket; ServerSideEncryptionConfiguration=@{ Rules=@(@{ ApplyServerSideEncryptionByDefault=@{ SSEAlgorithm='AES256' } }) } }
  Invoke-Aws @('s3api','put-bucket-encryption','--cli-input-json',$encryption,'--profile',$Profile,'--region',$Region) | Out-Null
  Invoke-Aws @('s3','cp',$BundlePath,"s3://$bucket/releases/current.zip",'--profile',$Profile,'--region',$Region,'--only-show-errors') | Out-Null

  $trustPolicy = Write-CliInput @{
    Version='2012-10-17'
    Statement=@(@{ Effect='Allow'; Principal=@{ Service='ec2.amazonaws.com' }; Action='sts:AssumeRole' })
  }
  $roleExists = $true
  try { Invoke-Aws @('iam','get-role','--role-name',$roleName,'--profile',$Profile) | Out-Null } catch { $roleExists = $false }
  if (-not $roleExists) {
    Invoke-Aws @('iam','create-role','--role-name',$roleName,'--description','BELORELLA production EC2 role for SSM and release/env reads','--assume-role-policy-document',$trustPolicy,'--profile',$Profile) | Out-Null
  }
  Invoke-Aws @('iam','attach-role-policy','--role-name',$roleName,'--policy-arn','arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore','--profile',$Profile) | Out-Null
  $ssmKeyArn = Get-Query @('kms','describe-key','--key-id','alias/aws/ssm','--profile',$Profile,'--region',$Region,'--query','KeyMetadata.Arn','--output','text')
  $appPolicy = Write-CliInput @{
    Version='2012-10-17'
    Statement=@(
      @{ Effect='Allow'; Action=@('ssm:GetParameter'); Resource="arn:aws:ssm:${Region}:${accountId}:parameter/belorella/prod/env" },
      @{ Effect='Allow'; Action=@('kms:Decrypt'); Resource=$ssmKeyArn },
      @{ Effect='Allow'; Action=@('s3:GetObject'); Resource="arn:aws:s3:::$bucket/releases/current.zip" }
    )
  }
  Invoke-Aws @('iam','put-role-policy','--role-name',$roleName,'--policy-name','BelorellaReleaseAndEnvironmentRead','--policy-document',$appPolicy,'--profile',$Profile) | Out-Null

  $instanceProfileExists = $true
  try { $instanceProfile = Invoke-AwsJson @('iam','get-instance-profile','--instance-profile-name',$profileName,'--profile',$Profile) } catch { $instanceProfileExists = $false }
  if (-not $instanceProfileExists) {
    $instanceProfile = Invoke-AwsJson @('iam','create-instance-profile','--instance-profile-name',$profileName,'--profile',$Profile)
  }
  $attachedRole = @($instanceProfile.InstanceProfile.Roles | ForEach-Object RoleName)
  if ($roleName -notin $attachedRole) {
    Invoke-Aws @('iam','add-role-to-instance-profile','--instance-profile-name',$profileName,'--role-name',$roleName,'--profile',$Profile) | Out-Null
  }

  $vpcId = Get-Query @('ec2','describe-vpcs','--profile',$Profile,'--region',$Region,'--filters','Name=isDefault,Values=true','--query','Vpcs[0].VpcId','--output','text')
  $subnetId = Get-Query @('ec2','describe-subnets','--profile',$Profile,'--region',$Region,'--filters','Name=availability-zone,Values=ap-southeast-2b','Name=default-for-az,Values=true','--query','Subnets[0].SubnetId','--output','text')
  $cloudFrontPrefixList = Get-Query @('ec2','describe-managed-prefix-lists','--profile',$Profile,'--region',$Region,'--filters','Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing','--query','PrefixLists[0].PrefixListId','--output','text')
  if (-not $vpcId -or $vpcId -eq 'None' -or -not $subnetId -or $subnetId -eq 'None' -or -not $cloudFrontPrefixList -or $cloudFrontPrefixList -eq 'None') {
    throw 'The default VPC, public subnet, or CloudFront origin prefix list is unavailable.'
  }

  $sgId = Get-Query @('ec2','describe-security-groups','--profile',$Profile,'--region',$Region,'--filters',"Name=group-name,Values=$securityGroupName","Name=vpc-id,Values=$vpcId",'--query','SecurityGroups[0].GroupId','--output','text')
  if (-not $sgId -or $sgId -eq 'None') {
    $sgId = Get-Query @('ec2','create-security-group','--profile',$Profile,'--region',$Region,'--group-name',$securityGroupName,'--description','HTTP origin reachable only through CloudFront; no SSH or public HTTPS','--vpc-id',$vpcId,'--query','GroupId','--output','text')
  }
  $securityGroup = Invoke-AwsJson @('ec2','describe-security-groups','--group-ids',$sgId,'--profile',$Profile,'--region',$Region)
  $hasCloudFrontHttp = @($securityGroup.SecurityGroups[0].IpPermissions | Where-Object {
    $_.IpProtocol -eq 'tcp' -and $_.FromPort -eq 80 -and $_.ToPort -eq 80 -and
    @($_.PrefixListIds | ForEach-Object PrefixListId) -contains $cloudFrontPrefixList
  }).Count -gt 0
  if (-not $hasCloudFrontHttp) {
    $permissions = Write-CliInput @{ GroupId=$sgId; IpPermissions=@(@{ IpProtocol='tcp'; FromPort=80; ToPort=80; PrefixListIds=@(@{PrefixListId=$cloudFrontPrefixList; Description='CloudFront origin-facing network'}) }) }
    Invoke-Aws @('ec2','authorize-security-group-ingress','--profile',$Profile,'--region',$Region,'--cli-input-json',$permissions) | Out-Null
  }

  $amiId = Get-Query @('ssm','get-parameter','--profile',$Profile,'--region',$Region,'--name','/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id','--query','Parameter.Value','--output','text')
  $instanceId = Get-Query @('ec2','describe-instances','--profile',$Profile,'--region',$Region,'--filters','Name=tag:Name,Values=BelorellaProductionWeb','Name=instance-state-name,Values=pending,running,stopping,stopped','--query','Reservations[0].Instances[0].InstanceId','--output','text')
  if (-not $instanceId -or $instanceId -eq 'None') {
    $bootstrap = Get-Content -LiteralPath $BootstrapPath -Raw
    $userData = "#!/bin/bash`nset -Eeuo pipefail`nbash -s -- $bucket releases/current.zip <<'BELORELLA_BOOTSTRAP'`n$bootstrap`nBELORELLA_BOOTSTRAP`n"
    $bootstrapFile = Join-Path $env:TEMP ("belorella-userdata-" + [guid]::NewGuid().ToString('N') + '.sh')
    $tempFiles.Add($bootstrapFile)
    [System.IO.File]::WriteAllText($bootstrapFile,$userData,[System.Text.UTF8Encoding]::new($false))
    $userDataBytes = [System.IO.File]::ReadAllBytes($bootstrapFile)
    $instanceRequest = @{
      ImageId=$amiId; InstanceType='t4g.small'; MinCount=1; MaxCount=1; SubnetId=$subnetId
      SecurityGroupIds=@($sgId); IamInstanceProfile=@{Name=$profileName}
      MetadataOptions=@{HttpEndpoint='enabled';HttpTokens='required';HttpPutResponseHopLimit=1}
      CreditSpecification=@{CpuCredits='standard'}
      BlockDeviceMappings=@(@{DeviceName='/dev/sda1';Ebs=@{VolumeSize=24;VolumeType='gp3';Encrypted=$true;DeleteOnTermination=$true}})
      UserData=[Convert]::ToBase64String($userDataBytes)
      TagSpecifications=@(
        @{ResourceType='instance';Tags=@(@{Key='Name';Value='BelorellaProductionWeb'};@{Key='Project';Value='belorella'})},
        @{ResourceType='volume';Tags=@(@{Key='Name';Value='BelorellaProductionWeb'};@{Key='Project';Value='belorella'})}
      )
    }
    $instanceInput = Write-CliInput $instanceRequest
    Start-Sleep -Seconds 15
    $instanceResult = Invoke-AwsJson @('ec2','run-instances','--cli-input-json',$instanceInput,'--profile',$Profile,'--region',$Region)
    $instanceId = $instanceResult.Instances[0].InstanceId
  }
  Invoke-Aws @('ec2','wait','instance-running','--instance-ids',$instanceId,'--profile',$Profile,'--region',$Region) | Out-Null

  $addresses = Invoke-AwsJson @('ec2','describe-addresses','--profile',$Profile,'--region',$Region)
  $address = @($addresses.Addresses | Where-Object { @($_.Tags | Where-Object { $_.Key -eq 'Project' -and $_.Value -eq 'belorella' }).Count -gt 0 } | Select-Object -First 1)[0]
  if (-not $address) {
    $allocationInput = Write-CliInput @{ Domain='vpc'; TagSpecifications=@(@{ResourceType='elastic-ip';Tags=@(@{Key='Name';Value='BelorellaProductionWeb'};@{Key='Project';Value='belorella'})}) }
    $address = Invoke-AwsJson @('ec2','allocate-address','--cli-input-json',$allocationInput,'--profile',$Profile,'--region',$Region)
  }
  if ($address.InstanceId -and $address.InstanceId -ne $instanceId) { throw 'The existing BELORELLA Elastic IP is attached to a different instance; refusing to move it.' }
  if (-not $address.InstanceId) { Invoke-Aws @('ec2','associate-address','--allocation-id',$address.AllocationId,'--instance-id',$instanceId,'--profile',$Profile,'--region',$Region) | Out-Null }
  Start-Sleep -Seconds 5
  $originDns = Get-Query @('ec2','describe-instances','--instance-ids',$instanceId,'--profile',$Profile,'--region',$Region,'--query','Reservations[0].Instances[0].PublicDnsName','--output','text')

  $cacheDisabledId='4135ea2d-6df8-44a3-9df3-4b5a84be39ad'
  $cacheOptimizedId='658327ea-f89d-4fab-a63d-7e88639e58f6'
  $allViewerId='216adef6-5c7f-47e4-b989-5492eafa07d3'
  $globalWafRegion='us-east-1'
  $wafPrefix='BelorellaCloudFrontProtection-'
  $existingWafs=Invoke-AwsJson @('wafv2','list-web-acls','--scope','CLOUDFRONT','--profile',$Profile,'--region',$globalWafRegion)
  $wafSummary=@($existingWafs.WebACLs | Where-Object { $_.Name.StartsWith($wafPrefix) } | Select-Object -First 1)[0]
  if ($wafSummary) {
    $wafName=$wafSummary.Name
    $waf=@{Summary=@{Name=$wafSummary.Name;Id=$wafSummary.Id;ARN=$wafSummary.ARN}}
    $suffix=$wafName.Substring($wafPrefix.Length)
  } else {
    $wafName="$wafPrefix$suffix"
    $wafInput = Write-CliInput @{
      Name=$wafName; Scope='CLOUDFRONT'; Description='Per-IP request-rate protection for the BELORELLA public site and API'
      DefaultAction=@{Allow=@{}}
      Rules=@(@{
        Name='RateLimitPerIp'; Priority=0; Action=@{Block=@{}}
        Statement=@{RateBasedStatement=@{Limit=2000;AggregateKeyType='IP'}}
        VisibilityConfig=@{SampledRequestsEnabled=$false;CloudWatchMetricsEnabled=$true;MetricName='BelorellaCloudFrontRateLimit'}
      })
      VisibilityConfig=@{SampledRequestsEnabled=$false;CloudWatchMetricsEnabled=$true;MetricName='BelorellaCloudFrontProtection'}
    }
    $waf=Invoke-AwsJson @('wafv2','create-web-acl','--cli-input-json',$wafInput,'--profile',$Profile,'--region',$globalWafRegion)
  }
  $wafLogGroup="aws-waf-logs-belorella-cloudfront-$suffix"
  $matchingLogs=Invoke-AwsJson @('logs','describe-log-groups','--log-group-name-prefix',$wafLogGroup,'--profile',$Profile,'--region',$globalWafRegion)
  if (-not @($matchingLogs.logGroups | Where-Object { $_.logGroupName -eq $wafLogGroup }).Count) {
    Invoke-Aws @('logs','create-log-group','--log-group-name',$wafLogGroup,'--profile',$Profile,'--region',$globalWafRegion) | Out-Null
  }
  Invoke-Aws @('logs','put-retention-policy','--log-group-name',$wafLogGroup,'--retention-in-days','14','--profile',$Profile,'--region',$globalWafRegion) | Out-Null
  $wafLogArn="arn:aws:logs:${globalWafRegion}:${accountId}:log-group:$wafLogGroup"
  $wafLogging = Write-CliInput @{
    LoggingConfiguration=@{
      ResourceArn=$waf.Summary.ARN
      LogDestinationConfigs=@($wafLogArn)
      RedactedFields=@(@{SingleHeader=@{Name='authorization'}};@{SingleHeader=@{Name='cookie'}})
    }
  }
  Invoke-Aws @('wafv2','put-logging-configuration','--cli-input-json',$wafLogging,'--profile',$Profile,'--region',$globalWafRegion) | Out-Null
  $distributionConfig = @{
    CallerReference=[guid]::NewGuid().ToString('N'); Comment='BELORELLA AWS preview and CDN'; Enabled=$true
    IsIPV6Enabled=$true; HttpVersion='http2'; PriceClass='PriceClass_All'
    Aliases=@{Quantity=0}; DefaultRootObject=''; OriginGroups=@{Quantity=0}; WebACLId=$waf.Summary.ARN
    Origins=@{Quantity=1;Items=@(@{Id='BelorellaEc2Origin';DomainName=$originDns;OriginPath='';CustomHeaders=@{Quantity=0};CustomOriginConfig=@{HTTPPort=80;HTTPSPort=443;OriginProtocolPolicy='http-only';OriginSslProtocols=@{Quantity=1;Items=@('TLSv1.2')};OriginReadTimeout=60;OriginKeepaliveTimeout=5};ConnectionAttempts=3;ConnectionTimeout=10})}
    DefaultCacheBehavior=@{TargetOriginId='BelorellaEc2Origin';ViewerProtocolPolicy='redirect-to-https';AllowedMethods=@{Quantity=7;Items=@('DELETE','GET','HEAD','OPTIONS','PATCH','POST','PUT');CachedMethods=@{Quantity=3;Items=@('GET','HEAD','OPTIONS')}};SmoothStreaming=$false;Compress=$true;CachePolicyId=$cacheDisabledId;OriginRequestPolicyId=$allViewerId}
    CacheBehaviors=@{Quantity=1;Items=@(@{PathPattern='/_next/static/*';TargetOriginId='BelorellaEc2Origin';ViewerProtocolPolicy='redirect-to-https';AllowedMethods=@{Quantity=3;Items=@('GET','HEAD','OPTIONS');CachedMethods=@{Quantity=3;Items=@('GET','HEAD','OPTIONS')}};SmoothStreaming=$false;Compress=$true;CachePolicyId=$cacheOptimizedId})}
    CustomErrorResponses=@{Quantity=0}; Restrictions=@{GeoRestriction=@{RestrictionType='none';Quantity=0}}
    ViewerCertificate=@{CloudFrontDefaultCertificate=$true;MinimumProtocolVersion='TLSv1.2_2021'}
    Logging=@{Enabled=$false;IncludeCookies=$false;Bucket='';Prefix=''}
  }
  $existingDists=Invoke-AwsJson @('cloudfront','list-distributions','--profile',$Profile)
  $distributionSummary=@($existingDists.DistributionList.Items | Where-Object { $_.Comment -eq 'BELORELLA AWS preview and CDN' } | Select-Object -First 1)[0]
  if ($distributionSummary) {
    $distribution=@{Distribution=@{Id=$distributionSummary.Id;DomainName=$distributionSummary.DomainName;Status=$distributionSummary.Status}}
  } else {
    $distributionInput = Write-CliInput @{ DistributionConfig=$distributionConfig }
    $distribution = Invoke-AwsJson @('cloudfront','create-distribution','--cli-input-json',$distributionInput,'--profile',$Profile)
  }
  $output = [ordered]@{
    region=$Region; bucket=$bucket; instanceId=$instanceId; instanceType='t4g.small'
    elasticIp=$address.PublicIp; allocationId=$address.AllocationId; securityGroupId=$sgId
    instanceRole=$roleName; instanceProfile=$profileName
    cloudFrontDistributionId=$distribution.Distribution.Id
    cloudFrontDomainName=$distribution.Distribution.DomainName
    webAclName=$wafName; webAclArn=$waf.Summary.ARN; wafLogGroup=$wafLogGroup
    CloudFrontStatus=$distribution.Distribution.Status
    mongoAtlasAllowlistActionRequired=$true; productionDnsChanged=$false
  }
  $outputPath = Join-Path $env:USERPROFILE '.belorella-aws-deployment.json'
  [System.IO.File]::WriteAllText($outputPath,(ConvertTo-Json $output -Depth 5),[System.Text.UTF8Encoding]::new($false))
  Write-Output (ConvertTo-Json $output -Depth 5)
  Write-Output "Deployment metadata saved to $outputPath"
  Write-Output 'The EC2 host is bootstrapping. The backend will stay offline until the rotated environment is uploaded to SSM and MongoDB Atlas allows the Elastic IP.'
} finally {
  foreach ($file in $tempFiles) { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue } }
}

