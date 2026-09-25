# 玄铁 VSCode 插件打包脚本(可复现版)
#   - 目录从脚本位置推导(旧版写死了作者机器上的绝对路径,别处必跑不了)
#   - 版本取自 package.json(旧版 manifest 里硬编码 0.19.2,与 package.json 长期不一致)
#   - 打包内容与实际发布的 vsix 结构对齐:extension/ 下含 server/xt_lsp.exe 与 snippets/(旧版漏拷)
#   - 输出 xuantie-<版本>.vsix 到扩展目录
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'

$extDir = $PSScriptRoot
$pkg = Get-Content -LiteralPath "$extDir\package.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
$outDir = "$extDir\out"
$vsixDir = "$outDir\extension"

if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Path $vsixDir -Force | Out-Null

# 顶层文件
foreach ($f in @('package.json', 'README.md', 'language-configuration.json', 'icon.ico', 'icon.png', 'extension.js', 'lspClient.js', 'pinyin-pro.js')) {
    Copy-Item "$extDir\$f" -Destination $vsixDir -Force
}
# 子目录(server 是 LSP 二进制,snippets 是拼音代码片段——旧版两者都漏了)
foreach ($d in @('syntaxes', 'snippets', 'server')) {
    if (Test-Path "$extDir\$d") {
        Copy-Item "$extDir\$d" -Destination $vsixDir -Recurse -Force
    }
}

# manifest:版本取自 package.json,避免与 package.json 漂移
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="xuantie-syntax" Version="$version" Publisher="xuantie"/>
    <DisplayName>XuanTie Syntax Highlighting</DisplayName>
    <Description xml:space="preserve">Syntax highlighting for XuanTie programming language</Description>
    <Tags>Programming Languages,snippet,xuantie,玄铁</Tags>
    <Categories>Programming Languages</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Badges></Badges>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.60.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace,web" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
    <Icon>extension/icon.ico</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.VsPackage" Path="extension/package.json" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icon.ico" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" />
  </Assets>
</PackageManifest>
"@
[System.IO.File]::WriteAllText("$outDir\extension.vsixmanifest", $manifest, (New-Object System.Text.UTF8Encoding($false)))

$vsix = "$extDir\xuantie-$version.vsix"
if (Test-Path $vsix) { Remove-Item $vsix -Force }
# Compress-Archive 只接受 .zip 扩展名 —— 先打 zip 再改名(与实际发布流程一致)
$zip = "$extDir\xuantie-$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$outDir\*" -DestinationPath $zip -Force
Move-Item $zip $vsix -Force
Remove-Item $outDir -Recurse -Force

Write-Output "已生成: $vsix"
