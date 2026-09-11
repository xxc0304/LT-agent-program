$ErrorActionPreference = "Stop"
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$key = Read-Host "Enter your DeepSeek API key locally (do not send it in chat)"
$env:DEEPSEEK_API_KEY = $key
Remove-Variable key
$env:DEEPSEEK_MODEL = "deepseek-v4-flash-vision-exp"
$env:DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions"

$resultPath = "data\scb\results\verified-v4-flash-vision-exp.json"
try {
  node src/evaluate-scb.js `
    --manifest "data\scb\manifest-verified.jsonl" `
    --out $resultPath
  if ($LASTEXITCODE -ne 0) { throw "Vision evaluation failed with exit code $LASTEXITCODE" }

  node src/print-summary.js $resultPath
  if ($LASTEXITCODE -ne 0) { throw "Could not read the result summary" }
} finally {
  Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
}
