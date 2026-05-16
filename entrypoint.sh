#!/bin/sh

# 定義目標路徑 (根據環境判斷)
TARGET_DIR="/usr/share/nginx/html"
if [ ! -d "$TARGET_DIR" ]; then
  TARGET_DIR="."
fi

# 如果是在本地端且有 .env 檔案，則加載它（僅用於本地測試）
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# 生成 config.js
cat <<EOF > ${TARGET_DIR}/config.js
/* 
  FlipCloud Ebook Configuration (Auto-generated)
  Generated at: $(date)
*/
window.VITE_SUPABASE_URL = '${VITE_SUPABASE_URL}';
window.VITE_ANON_KEY = '${VITE_ANON_KEY}';
window.VITE_SERVICE_ROLE_KEY = '${SERVICE_ROLE_KEY}';
EOF

echo "✓ config.js 已生成 (URL: ${VITE_SUPABASE_URL})"

# 只有在 Docker 環境中（存在 /usr/share/nginx/html）才啟動 Nginx
if [ "$TARGET_DIR" = "/usr/share/nginx/html" ]; then
  nginx -g "daemon off;"
fi
