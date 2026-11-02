#ifndef BuildId
  #error Build with bun run build:installer.
#endif
#ifndef BunMinimum
  #error Build with bun run build:installer.
#endif
#ifndef PwshMinimum
  #error Build with bun run build:installer.
#endif
#ifndef BunFallbackVersion
  #error Build with bun run build:installer.
#endif
#ifndef PwshFallbackVersion
  #error Build with bun run build:installer.
#endif

[Setup]
AppId={{62D461A2-B327-45DA-B286-50B635DD84EA}
AppName=Summon
AppVersion={#AppVersion}
AppPublisher=NomadicDaddy
DefaultDirName={localappdata}\Programs\Summon
DefaultGroupName=Summon
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
OutputBaseFilename=summon-{#BuildId}-windows-x64
Compression=lzma2/fast
SolidCompression=yes
SetupLogging=yes
UninstallLogging=yes
; Upgrades retain every version's logged files for the eventual uninstall.
UninstallLogMode=append
CloseApplications=no
RestartApplications=no
ChangesEnvironment=yes
DisableProgramGroupPage=yes
SetupIconFile=..\src\desktop\icons\summon.ico
UninstallDisplayIcon={app}\versions\{#BuildId}\app\dist\team\icons\summon.ico
LicenseFile=..\LICENSE
WizardStyle=modern
WizardImageFile=artwork\wizard-image-202x386.png,artwork\wizard-image-269x515.png,artwork\wizard-image-336x643.png,artwork\wizard-image-403x772.png,artwork\wizard-image-430x824.png,artwork\wizard-image-498x953.png,artwork\wizard-image-534x1022.png
WizardSmallImageFile=artwork\wizard-small-image-58x58.png,artwork\wizard-small-image-77x77.png,artwork\wizard-small-image-97x97.png,artwork\wizard-small-image-116x116.png,artwork\wizard-small-image-124x124.png,artwork\wizard-small-image-143x143.png,artwork\wizard-small-image-159x159.png

[Files]
Source: "{#Payload}\*"; DestDir: "{app}\versions\{#BuildId}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Launcher}"; DestDir: "{app}"; Flags: ignoreversion
; Setup-time only: extracted to {tmp} for the Dependencies page, never installed or bundled runtimes.
Source: "prerequisites.ps1"; Flags: dontcopy
Source: "prerequisite-sources.json"; Flags: dontcopy

[Icons]
Name: "{group}\Summon"; Filename: "{cmd}"; Parameters: "/c """"{app}\summon.cmd"" --team"""; WorkingDir: "{userdocs}"; IconFilename: "{app}\versions\{#BuildId}\app\dist\team\icons\summon.ico"

[Code]
var
  RuntimeBlocker: String;
  DependencyPage: TInputOptionWizardPage;
  BunStatus, BunVersion, PwshStatus, PwshVersion: String;
  WingetAvailable: Boolean;
  DependencyReport: String;
  UninstallReport: String;
  FinishedDetails: TNewMemo;

// Dependencies (installer-installs-runtime-prerequisites): the PowerShell 5.1 helper does all
// detection and installation, so this layer only runs it, reads its key=value file and reports.
// A failed, skipped or cancelled dependency never stops or rolls back Summon's own installation.
function ReadHelperValue(Lines: TArrayOfString; Key: String): String;
var
  Index: Integer;
begin
  Result := '';
  for Index := 0 to GetArrayLength(Lines) - 1 do
    if Pos(Key + '=', Lines[Index]) = 1 then begin
      Result := Copy(Lines[Index], Length(Key) + 2, Length(Lines[Index]));
      exit;
    end;
end;

function RunHelper(Arguments: String; OutFile: String; var Lines: TArrayOfString): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  SetArrayLength(Lines, 0);
  DeleteFile(OutFile);
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\prerequisites.ps1') + '" ' +
    Arguments +
    ' -SourcesPath "' + ExpandConstant('{tmp}\prerequisite-sources.json') + '"' +
    ' -BunMinimum {#BunMinimum} -PwshMinimum {#PwshMinimum}' +
    ' -OutFile "' + OutFile + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then exit;
  Result := LoadStringsFromFile(OutFile, Lines);
end;

procedure DetectDependencies();
var
  Lines: TArrayOfString;
begin
  BunStatus := 'unknown';
  PwshStatus := 'unknown';
  BunVersion := '';
  PwshVersion := '';
  WingetAvailable := False;
  try
    ExtractTemporaryFile('prerequisites.ps1');
    ExtractTemporaryFile('prerequisite-sources.json');
    if RunHelper('-Mode detect', ExpandConstant('{tmp}\prerequisites-detect.txt'), Lines) then begin
      BunStatus := ReadHelperValue(Lines, 'bun.status');
      BunVersion := ReadHelperValue(Lines, 'bun.version');
      PwshStatus := ReadHelperValue(Lines, 'pwsh.status');
      PwshVersion := ReadHelperValue(Lines, 'pwsh.version');
      WingetAvailable := ReadHelperValue(Lines, 'winget') = '1';
    end;
  except
    Log('Dependency detection failed: ' + GetExceptionMessage);
  end;
  if BunStatus = '' then BunStatus := 'unknown';
  if PwshStatus = '' then PwshStatus := 'unknown';
end;

function DependencyCaption(Name, Status, Version, Minimum: String): String;
begin
  if Status = 'found' then Result := Name + ': found ' + Version
  else if Status = 'outdated' then Result := Name + ': too old (' + Version + '; needs ' + Minimum + ' or later)'
  else if Status = 'unreadable' then Result := Name + ': found, but its version could not be read'
  else if Status = 'missing' then Result := Name + ': not found'
  else Result := Name + ': could not be checked';
end;

function DependencyNeeded(Status: String): Boolean;
begin
  Result := (Status = 'missing') or (Status = 'outdated') or (Status = 'unreadable');
end;

procedure TermsLinkClick(Sender: TObject; const Link: String; LinkType: TSysLinkType);
var
  ErrorCode: Integer;
begin
  ShellExecAsOriginalUser('open', Link, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
end;

procedure CreateDependencyPage();
var
  Route: String;
  Terms: TNewLinkLabel;
begin
  if WingetAvailable then
    Route := 'Bun installs for your account with winget (package Oven-sh.Bun), or from Bun''s pinned official GitHub release if winget has no installer for it. ' +
      'PowerShell installs for all users with winget (package Microsoft.PowerShell): Windows will show a UAC prompt for it, and declining that prompt skips PowerShell. ' +
      'winget checks its own package hash; a pinned official release is checked against its SHA256 before it is unpacked.'
  else
    Route := 'winget is not available, so each checked item is installed for your account from its pinned official GitHub release, checked against its SHA256 before it is unpacked. No UAC prompt is needed.';
  DependencyPage := CreateInputOptionPage(wpSelectDir, 'Dependencies',
    'Bun {#BunMinimum} or later and PowerShell {#PwshMinimum} or later',
    'Summon needs Bun to start and PowerShell 7 for its sessions. Checked items are installed during setup; clear a box to install that one yourself later. ' +
    Route + ' An older bun.exe in your Bun folder is kept beside the new one. ' +
    'A dependency that fails or is skipped never stops Summon''s own installation.',
    False, False);
  DependencyPage.Add(DependencyCaption('Bun', BunStatus, BunVersion, '{#BunMinimum}'));
  DependencyPage.Add(DependencyCaption('PowerShell 7', PwshStatus, PwshVersion, '{#PwshMinimum}'));
  DependencyPage.Values[0] := DependencyNeeded(BunStatus);
  DependencyPage.Values[1] := DependencyNeeded(PwshStatus);
  // A current runtime is shown for information only and cannot be reinstalled from here.
  DependencyPage.CheckListBox.ItemEnabled[0] := BunStatus <> 'found';
  DependencyPage.CheckListBox.ItemEnabled[1] := PwshStatus <> 'found';
  DependencyPage.CheckListBox.Height := ScaleY(48);
  // D2 (Phillip A #26082): the terms are real links on this page, before the consent they cover.
  Terms := TNewLinkLabel.Create(DependencyPage);
  Terms.Parent := DependencyPage.Surface;
  Terms.Left := 0;
  Terms.Top := DependencyPage.CheckListBox.Top + DependencyPage.CheckListBox.Height + ScaleY(8);
  Terms.Width := DependencyPage.SurfaceWidth;
  Terms.AutoSize := False;
  Terms.Height := ScaleY(64);
  Terms.Caption := 'Leaving a box checked accepts that package''s licence, which is its winget package agreement, and the agreements of winget''s community source: ' +
    '<a href="https://github.com/oven-sh/bun/blob/bun-v{#BunFallbackVersion}/LICENSE.md">Bun licence (MIT)</a>, ' +
    '<a href="https://github.com/PowerShell/PowerShell/blob/v{#PwshFallbackVersion}/LICENSE.txt">PowerShell licence (MIT)</a>, ' +
    '<a href="https://github.com/microsoft/winget-pkgs">winget community source</a>.';
  Terms.OnLinkClick := @TermsLinkClick;
end;

procedure InstallDependency(Index: Integer; Id, Name: String);
var
  Lines: TArrayOfString;
  Outcome, Detail: String;
begin
  if not DependencyPage.Values[Index] or not DependencyPage.CheckListBox.ItemEnabled[Index] then exit;
  WizardForm.StatusLabel.Caption := 'Installing ' + Name + '...';
  Outcome := 'failed';
  Detail := 'The prerequisite helper did not report a result.';
  try
    if RunHelper('-Mode install -Id ' + Id, ExpandConstant('{tmp}\prerequisites-' + Id + '.txt'), Lines) then begin
      Outcome := ReadHelperValue(Lines, 'outcome');
      Detail := ReadHelperValue(Lines, 'detail');
    end;
  except
    Detail := 'The prerequisite helper could not run.';
  end;
  Log(Format('Dependency %s: %s (%s %s) %s', [Id, Outcome, ReadHelperValue(Lines, 'route'), ReadHelperValue(Lines, 'code'), Detail]));
  if Outcome = 'installed' then
    DependencyReport := DependencyReport + Name + ' ' + ReadHelperValue(Lines, 'version') + ' was installed. '
  else if Outcome = 'cancelled' then
    DependencyReport := DependencyReport + Name + ' was not installed: the installation was cancelled. '
  else if (Outcome = 'unverified') or (Outcome = 'unfinished') then
    DependencyReport := DependencyReport + Name + ': ' + Detail + ' '
  else
    DependencyReport := DependencyReport + Name + ' was not installed: ' + Detail + ' ';
end;

procedure InstallDependencies();
begin
  DependencyReport := '';
  // Consent is the visible page; a silent install never downloads or elevates anything.
  if WizardSilent() or (DependencyPage = nil) then exit;
  InstallDependency(0, 'bun', 'Bun');
  InstallDependency(1, 'pwsh', 'PowerShell');
end;

function RuntimeIsRunning(): Boolean;
var
  Locator, Service, Processes, Process: Variant;
  Index: Integer;
  FileName, CommandLine, Root: String;
begin
  Result := False;
  RuntimeBlocker := '';
  Root := Lowercase(AddBackslash(ExpandConstant('{app}')));
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('', 'root\CIMV2');
    Processes := Service.ExecQuery('SELECT Name, ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE Name=''bun.exe'' OR Name=''electron.exe'' OR Name=''pwsh.exe''');
    for Index := 0 to Processes.Count - 1 do begin
      Process := Processes.ItemIndex(Index);
      if not VarIsNull(Process.ExecutablePath) then begin
        FileName := Lowercase(Process.ExecutablePath);
        if Pos(Root, FileName) = 1 then Result := True;
      end;
      // External Bun/pwsh live outside {app}; their installed script path identifies ownership.
      if VarIsNull(Process.CommandLine) then begin
        Result := True;
        RuntimeBlocker := Format('%s (PID %d) has an unreadable command line; ownership cannot be verified.', [String(Process.Name), Integer(Process.ProcessId)]);
      end
      else begin
        CommandLine := Lowercase(Process.CommandLine);
        if Pos(Root, CommandLine) > 0 then Result := True;
      end;
      if Result then begin
        if RuntimeBlocker = '' then
          RuntimeBlocker := Format('%s (PID %d) is using this installation.', [String(Process.Name), Integer(Process.ProcessId)]);
        exit;
      end;
    end;
  except
    // Fail closed: installation must never interrupt an unverified running session.
    Result := True;
    RuntimeBlocker := 'Process inspection failed; ownership cannot be verified.';
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if RuntimeIsRunning() then
    Result := 'Close Summon Team Windows and all sessions from this installation, then retry. ' + RuntimeBlocker;
end;

function InitializeUninstall(): Boolean;
begin
  Result := not RuntimeIsRunning();
  if not Result then
    MsgBox('Close Summon Team Windows and sessions before uninstalling. ' + RuntimeBlocker + ' Your team data and settings will be retained.', mbError, MB_OK);
end;

procedure UpdateUserPath(AddEntry: Boolean);
var
  Existing, Entry, NewPath, Part: String;
  Items: TArrayOfString;
  Index: Integer;
  Found, Changed: Boolean;
begin
  Entry := ExpandConstant('{app}');
  Existing := '';
  if RegValueExists(HKCU, 'Environment', 'Path') and
    not RegQueryStringValue(HKCU, 'Environment', 'Path', Existing) then
    RaiseException('Cannot read the current-user PATH; it was left unchanged.');
  Items := StringSplit(Existing, [';'], stExcludeEmpty);
  NewPath := '';
  Found := False;
  Changed := False;
  for Index := 0 to GetArrayLength(Items) - 1 do begin
    Part := Trim(Items[Index]);
    if (Length(Part) >= 2) and (Part[1] = '"') and (Part[Length(Part)] = '"') then
      Part := Copy(Part, 2, Length(Part) - 2);
    if CompareText(RemoveBackslashUnlessRoot(Part), RemoveBackslashUnlessRoot(Entry)) = 0 then begin
      Found := True;
      if not AddEntry then begin
        Changed := True;
        continue;
      end;
    end;
    if NewPath <> '' then NewPath := NewPath + ';';
    NewPath := NewPath + Items[Index];
  end;
  if AddEntry and not Found then begin
    if NewPath <> '' then NewPath := NewPath + ';';
    NewPath := NewPath + Entry;
    Changed := True;
  end;
  if not Changed then exit;
  if NewPath = '' then begin
    if not RegDeleteValue(HKCU, 'Environment', 'Path') then
      RaiseException('Cannot remove the current-user PATH entry.');
  end
  // This preserves REG_EXPAND_SZ when present; otherwise it writes REG_SZ.
  else if not RegWriteStringValue(HKCU, 'Environment', 'Path', NewPath) then
    RaiseException('Cannot update the current-user PATH.');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    InstallDependencies();
    try
      UpdateUserPath(True);
    except
      Log('Summon PATH update failed: ' + GetExceptionMessage);
      DependencyReport := DependencyReport + 'PATH was not updated; start Summon from Start. ';
    end;
  end;
end;

procedure RemoveInterruptedSetupFiles(Directory: String; ScanSubdirs: Boolean);
var
  Entry, RootEntry: TFindRec;
  RootAttributes: LongWord;
  Path: String;
begin
  if not DirExists(Directory) then exit;
  if not FindFirst(RemoveBackslashUnlessRoot(Directory), RootEntry) then
    RaiseException('Cannot inspect interrupted setup files: ' + Directory);
  RootAttributes := RootEntry.Attributes;
  FindClose(RootEntry);
  if RootAttributes and FILE_ATTRIBUTE_REPARSE_POINT <> 0 then exit;
  if FindFirst(AddBackslash(Directory) + '*', Entry) then begin
    try
      repeat
        if (Entry.Name <> '.') and (Entry.Name <> '..') and
          (Entry.Attributes and FILE_ATTRIBUTE_REPARSE_POINT = 0) then begin
          Path := AddBackslash(Directory) + Entry.Name;
          if Entry.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0 then begin
            if ScanSubdirs then RemoveInterruptedSetupFiles(Path, True);
          end else if (CompareText(Copy(Entry.Name, 1, 3), 'is-') = 0) and
            (CompareText(ExtractFileExt(Entry.Name), '.tmp') = 0) then begin
            if not DeleteFile(Path) then
              RaiseException('Cannot remove interrupted setup file: ' + Path);
          end;
        end;
      until not FindNext(Entry);
    finally
      FindClose(Entry);
    end;
  end;
  // Prune empty orphan version directories without deleting their unknown contents.
  if ScanSubdirs then RemoveDir(Directory);
end;

procedure TryRemoveInterruptedSetupFiles(Directory: String; ScanSubdirs: Boolean);
begin
  try
    RemoveInterruptedSetupFiles(Directory, ScanSubdirs);
  except
    Log('Interrupted setup cleanup failed: ' + GetExceptionMessage);
    UninstallReport := UninstallReport + ' Some interrupted setup files could not be removed. Close programs using the installation folder and remove the remaining files manually. Your team data and settings were retained.';
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then begin
    // A killed Setup can leave unlogged staging files; retain all other unknown files.
    TryRemoveInterruptedSetupFiles(ExpandConstant('{app}'), False);
    TryRemoveInterruptedSetupFiles(ExpandConstant('{app}\versions'), True);
    try
      UpdateUserPath(False);
    except
      Log('Summon PATH removal failed: ' + GetExceptionMessage);
      UninstallReport := UninstallReport + ' The Summon entry could not be removed from your PATH; remove it in Windows Environment Variables.';
    end;
  end;
  if CurUninstallStep = usPostUninstall then begin
    // Recovered installs can contain directories created before Setup logged them.
    TryRemoveInterruptedSetupFiles(ExpandConstant('{app}\versions'), True);
    // The engine already retried this parent before the orphan directories were pruned.
    RemoveDir(ExpandConstant('{app}'));
  end;
  if (CurUninstallStep = usDone) and (UninstallReport <> '') then begin
    Log(UninstallReport);
    if not UninstallSilent() then MsgBox(UninstallReport, mbInformation, MB_OK);
  end;
end;

procedure InitializeWizard();
begin
  // A silent install shows no page and installs no dependency, so it runs no detection either.
  if WizardSilent() then exit;
  DetectDependencies();
  CreateDependencyPage();
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID <> wpFinished then exit;
  WizardForm.FinishedLabel.Caption := 'Summon is installed. Review the setup results and next steps below.';
  WizardForm.FinishedLabel.Height := ScaleY(32);
  if FinishedDetails = nil then begin
    FinishedDetails := TNewMemo.Create(WizardForm);
    FinishedDetails.Parent := WizardForm.FinishedPage;
    FinishedDetails.ReadOnly := True;
    FinishedDetails.ScrollBars := ssVertical;
    FinishedDetails.WordWrap := True;
    FinishedDetails.SetBounds(WizardForm.FinishedLabel.Left,
      WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(8),
      WizardForm.FinishedLabel.Width,
      WizardForm.FinishedPage.Height - WizardForm.FinishedLabel.Top - WizardForm.FinishedLabel.Height - ScaleY(16));
  end;
  FinishedDetails.Text :=
    'Summon is installed for your Windows account. Open Summon from Start, or open a new terminal and run summon --team.' + #13#10 + #13#10 +
    DependencyReport + #13#10 +
    'Setup checks the PATH that newly started programs receive. A terminal or program that was already open keeps its old PATH; open a new terminal, or start Summon from Start, to use what setup found or installed.' + #13#10 + #13#10 +
    'If Bun {#BunMinimum} or later or PowerShell {#PwshMinimum} or later is still missing, install it separately, and keep bun.exe and pwsh.exe on PATH. Bun is required before Summon can open.' + #13#10 +
    'Bun: https://bun.com/docs/installation' + #13#10 +
    'PowerShell: https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows' + #13#10 + #13#10 +
    'Open first-run setup or Maintenance for prerequisite checks, provider CLI installation links, account requirements and the Summon capability matrix. Install a supported CLI and complete its sign-in before starting a teammate; a subscription alone does not configure the CLI.' + #13#10 + #13#10 +
    'After installing a provider CLI, reopen Summon to receive the updated PATH, then refresh its CLI check. A version check does not verify sign-in or account access. Provider credentials remain with that provider.' + #13#10 + #13#10 +
    'Electron and application library dependencies are included; Bun and PowerShell are offered on the Dependencies page and downloaded only when checked, and provider CLIs are not included. Uninstall retains your team data and settings and separately installed prerequisites.';
end;
