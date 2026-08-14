; 玄铁 v1.0-rc 安装器脚本(Inno Setup 6/7)
; payload 来自 temp/pkg_test/玄铁(由 temp/make_pkg.sh 生成)
; 构建: iscc xuantie_setup.iss

#define MyAppName "玄铁 (XuanTie)"
#define MyAppVersion "1.0-rc"

[Setup]
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=XuanTie
AppPublisherURL=https://github.com/MARKJY-China/XuanTie-Lang
DefaultDirName={autopf}\XuanTie
PrivilegesRequired=lowest
OutputDir=.
OutputBaseFilename=xuantie_v1.0-rc_setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
DisableProgramGroupPage=yes
UninstallDisplayName={#MyAppName}
; 中文界面
ShowLanguageDialog=no

[Registry]
; 玄铁安装目录写入用户环境变量(UI 库默认字体等运行时资源按此定位);卸载自动删除
Root: HKCU; Subkey: "Environment"; ValueType: string; ValueName: "XUANTIE_HOME"; ValueData: "{app}"; Flags: uninsdeletevalue

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "addpath"; Description: "把玄铁加入用户 PATH(推荐,终端可直接使用 xtc)"; GroupDescription: "环境配置:"; Flags: checkedonce

[Files]
Source: "..\temp\pkg_test\XuanTie\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Code]
// 追加 {app} 到用户 PATH(幂等:已含则不重复)
procedure AddToUserPath();
var
  OldPath: String;
  AppDir: String;
begin
  AppDir := ExpandConstant('{app}');
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', OldPath) then
    OldPath := '';
  if Pos(Uppercase(AppDir), Uppercase(OldPath)) = 0 then
  begin
    if (Length(OldPath) > 0) and (OldPath[Length(OldPath)] <> ';') then
      OldPath := OldPath + ';';
    RegWriteStringValue(HKCU, 'Environment', 'Path', OldPath + AppDir);
  end;
end;

// 从用户 PATH 移除 {app}
procedure RemoveFromUserPath();
var
  OldPath, NewPath, AppDir: String;
  P: Integer;
begin
  AppDir := ExpandConstant('{app}');
  if RegQueryStringValue(HKCU, 'Environment', 'Path', OldPath) then
  begin
    NewPath := OldPath;
    P := Pos(Uppercase(AppDir), Uppercase(NewPath));
    while P > 0 do
    begin
      Delete(NewPath, P, Length(AppDir));
      // 清理可能残留的双分号/尾分号
      while Pos(';;', NewPath) > 0 do
        StringChangeEx(NewPath, ';;', ';', True);
      if (Length(NewPath) > 0) and (NewPath[Length(NewPath)] = ';') then
        Delete(NewPath, Length(NewPath), 1);
      if (Length(NewPath) > 0) and (NewPath[1] = ';') then
        Delete(NewPath, 1, 1);
      P := Pos(Uppercase(AppDir), Uppercase(NewPath));
    end;
    if NewPath <> OldPath then
      RegWriteStringValue(HKCU, 'Environment', 'Path', NewPath);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('addpath') then
    AddToUserPath();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemoveFromUserPath();
end;

[Messages]
chinesesimp.FinishedLabel=安装完成!%n%n验证方式:打开新的终端,执行%n  xtc 铁 hello.xt%n%n语言手册见安装目录 GUIDE\,VSCode 插件(xuantie-*.vsix)双击即可安装。
