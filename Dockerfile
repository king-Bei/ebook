FROM nginx:alpine

# 將目前目錄下的所有網頁檔案複製到 Nginx 的預設網頁目錄
COPY . /usr/share/nginx/html

# 確保 Nginx 監聽 Cloud Run 指定的 8080 端口（Cloud Run 預設要求）
RUN sed -i 's/listen  80;/listen 8080;/g' /etc/nginx/conf.d/default.conf

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
