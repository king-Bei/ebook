FROM nginx:alpine

# 1. 複製網頁檔案
COPY . /usr/share/nginx/html

# 2. 移除預設的設定檔，並複製自訂的 nginx.conf
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 3. 設定啟動腳本
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Cloud Run 預設要求監聽 8080
EXPOSE 8080

CMD ["/entrypoint.sh"]
