FROM nginx:alpine

# 1. 複製網頁檔案
COPY . /usr/share/nginx/html

# 2. 移除預設的設定檔，並複製自訂的 nginx.conf
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Cloud Run 預設要求監聽 8080
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
