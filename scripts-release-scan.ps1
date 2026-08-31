# Syrinx full-history API key leak scan (brief step 3)
$hist = Join-Path $env:TEMP 'syrinx-fullhist.txt'
$lines = Get-Content $hist

$patterns = @(
  @{ Name = 'A1-sk-key';       Re = 'sk-[a-zA-Z0-9]{20,}' },
  @{ Name = 'A2-ARK-VOLC-KEY'; Re = 'ARK_[A-Z_]*KEY|VOLC[A-Z_]*KEY' },
  @{ Name = 'A3-ANTHROPIC';    Re = 'ANTHROPIC_AUTH_TOKEN' },
  @{ Name = 'B-apikey-16plus'; Re = '(?i)api[_-]?key.{0,40}[a-zA-Z0-9]{16,}' },
  @{ Name = 'C-token-forms';   Re = "(?i)(secret|token|bearer)\s*[:=]\s*[`"']?[a-zA-Z0-9_\-]{24,}" }
)

$hits = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
  foreach ($p in $patterns) {
    if ($lines[$i] -match $p.Re) {
      $sha = ''
      for ($j = $i; $j -ge 0 -and $j -ge $i - 400; $j--) {
        if ($lines[$j] -match '^commit ([0-9a-f]{40})') { $sha = $Matches[1]; break }
      }
      $t = $lines[$i].Trim()
      if ($t.Length -gt 160) { $t = $t.Substring(0, 160) }
      $hits += [pscustomobject]@{ Pattern = $p.Name; Line = $i + 1; Sha = $sha; Text = $t }
      break
    }
  }
}

"TOTAL HITS: $($hits.Count)"
$hits | Group-Object Pattern | ForEach-Object { "{0} x{1}" -f $_.Name, $_.Count }
"---- first 60 hits ----"
$hits | Select-Object -First 60 | ForEach-Object { "{0} | {1} | {2} | {3}" -f $_.Pattern, $_.Sha.Substring(0,8), $_.Line, $_.Text }
