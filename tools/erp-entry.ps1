# LETUS PMS '어카운트 입력' 실행기
# PMS 버튼 -> letus-erp:// 링크 -> 이 스크립트 -> 클립보드의 PMS 전표 요청문 확인 -> Claude Code(Chrome 연동) 실행
# 링크 주소에 담긴 내용은 쓰지 않는다(다른 사이트가 명령을 넣지 못하게). 요청문은 클립보드에서만, PMS 표식이 있을 때만.
param([string]$Url = "")
Add-Type -AssemblyName PresentationFramework
$MARK = "[LETUS-PMS-ERP-V1]"
$text = Get-Clipboard -Raw
if (-not $text -or -not $text.StartsWith($MARK)) {
  [System.Windows.MessageBox]::Show("클립보드에 PMS 전표 요청문이 없어요.`nPMS 마감 화면에서 '어카운트 입력'을 다시 눌러 주세요.", "LETUS 어카운트 입력") | Out-Null
  exit 1
}
# 요청문은 계정코드·금액·적요 줄만 허용 (길이 제한)
if ($text.Length -gt 20000) { [System.Windows.MessageBox]::Show("요청문이 너무 길어요.", "LETUS 어카운트 입력") | Out-Null; exit 1 }

# 앱 업데이트로 경로(버전)가 바뀌므로 가장 최신 claude.exe를 찾는다
$root = Join-Path $env:LOCALAPPDATA "Claude-Data"
$exe = Get-ChildItem $root -Recurse -Filter "claude.exe" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "\\claude-code\\" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exe) { [System.Windows.MessageBox]::Show("Claude Code(claude.exe)를 찾지 못했어요.", "LETUS 어카운트 입력") | Out-Null; exit 1 }

$dir = Join-Path $env:TEMP "letus-erp"
New-Item -ItemType Directory -Force $dir | Out-Null
$file = Join-Path $dir ("erp_request_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".txt")
Set-Content -Path $file -Value $text -Encoding utf8

$prompt = "PMS '어카운트 입력' 버튼으로 실행됨. $file 파일의 전표 요청대로 Claude in Chrome으로 ERP 전표등록에 입력해줘. 전표저장·상신은 절대 하지 말고, 차대변 합계 확인 후 멈춰서 알려줘."
Start-Process -FilePath $exe.FullName -ArgumentList @("--chrome", "`"$prompt`"") -WorkingDirectory "C:\letus-pms"
