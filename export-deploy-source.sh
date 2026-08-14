#!/usr/bin/env bash
# deploy用ソースをクリーンにエクスポートする（開発用リソースを除外）。
# 除外対象は .gitattributes の export-ignore エントリで定義。
#
# 使い方:
#   ./export-deploy-source.sh                 # -> rapid-deploy-source.tar
#   ./export-deploy-source.sh release.zip     # 任意の出力名（.zip なら zip 形式）
#
# 受領側: 展開後 `cd rapid-deploy/cdk && npm ci && npm run deploy`
set -euo pipefail

OUT="${1:-rapid-deploy-source.tar}"
case "$OUT" in
  *.zip) FMT="zip" ;;
  *)     FMT="tar" ;;
esac

git archive --format="$FMT" --prefix=rapid-deploy/ -o "$OUT" HEAD
echo "exported $OUT"

echo "--- dev-path check (should be CLEAN) ---"
if tar -tf "$OUT" 2>/dev/null | grep -Ei '\.claude/|\.agents/|/docs/|/logs/|CLAUDE\.md|CONTEXT\.md|MyNeeds\.md|skills-lock|touki-check|/fixtures/'; then
  echo "FOUND DEV PATHS (bad)"; exit 1
else
  echo "OK: clean (no dev resources)"
fi
