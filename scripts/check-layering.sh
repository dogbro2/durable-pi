#!/usr/bin/env bash
# 分層邊界檢查（ADR-0001 §9.6）：目錄不存在時跳過，命中禁止模式即失敗。
# 階段 6 起 DDL 只允許在 db/migrations.ts；組合根不得殘留相容層。
set -u

fail=0
chk() {
	[ -d "$1" ] && grep -rEn "$2" "$1" --include='*.ts' && fail=1
	return 0
}
chkf() {
	[ -f "$1" ] && grep -En "$2" "$1" && fail=1
	return 0
}
chk src/worker/routes   'sqlFacade|sql\.exec\('
# 階段 7（NERE-79）：錯誤只經 toResponse；禁止路由內 String(err) 與手寫錯誤響應體。
chk src/worker/routes   'String[(]err[)]'
chk src/worker/routes   'new Response[(][[:space:]]*JSON[.]stringify[(][[:space:]]*[{][[:space:]]*error'
chk src/worker/routes   'Response[.]json[(][[:space:]]*[{][[:space:]]*(ok:[[:space:]]*false,[[:space:]]*)?error'
chk src/worker/services 'new Response|Response\.(json|redirect)|^\s*import .*routes/'
chk src/worker/repo     'new Response|Response\.(json|redirect)|from "\.\./services|from "\.\./routes'
# 階段 6：相容層歸零（含 worker/ 下除 db 外的全部新模組；db/migrations.ts 不含這些識別符號）。
chk src/worker 'ensureTables|sqlFacade|\bscope\('
# DDL 只允許在 db/migrations.ts：組合根不得出現建表/改表。
chkf src/worker.ts 'CREATE TABLE|ALTER TABLE'
# 組合根不再有 legacy 委託與隱式作用域。
chkf src/worker.ts 'handleLegacyFetch|\.legacy\(|ensureTables|sqlFacade|\bscope\('
[ "$fail" = 0 ] || { echo "分層邊界檢查失敗"; exit 1; }
