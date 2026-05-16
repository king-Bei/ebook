/* 
  FlipCloud Ebook Shared Logic & Auth System 
  (Connected to travel-brochure Supabase)
*/

// 從全域環境變數讀取，若無則使用預設值 (建議由建置工具或伺服器注入)
const SB_URL = window.VITE_SUPABASE_URL
const SB_KEY = window.VITE_ANON_KEY

// Initialize Supabase Client
const { createClient } = supabase;
window.sb = createClient(SB_URL, SB_KEY);

const SESSION_KEY = 'ebook_user_session';
const LAST_ACTIVITY_KEY = 'ebook_last_activity';
const SESSION_TIMEOUT = 2 * 60 * 60 * 1000; // 2 小時 (毫秒)

window.auth = {
    async login(identifier, password) {
        try {
            // 呼叫與 travel-brochure 相同的驗證邏輯
            const { data, error } = await window.sb.rpc('check_user_password', {
                p_employee_id: identifier,
                p_password: password
            });

            if (error || !data?.success) {
                return { success: false, message: error?.message || '帳號或密碼錯誤' };
            }

            // 儲存 Session
            localStorage.setItem(SESSION_KEY, JSON.stringify(data.user));
            localStorage.setItem(LAST_ACTIVITY_KEY, Date.now().toString());
            return { success: true };
        } catch (err) {
            console.error('Auth error:', err);
            return { success: false, message: '連線失敗' };
        }
    },

    getCurrentUser() {
        // 檢查是否過期
        const lastActivity = localStorage.getItem(LAST_ACTIVITY_KEY);
        if (lastActivity && Date.now() - parseInt(lastActivity, 10) > SESSION_TIMEOUT) {
            this.logout();
            return null;
        }

        const userJson = localStorage.getItem(SESSION_KEY);
        if (!userJson) return null;

        // 更新最後活動時間
        localStorage.setItem(LAST_ACTIVITY_KEY, Date.now().toString());
        return JSON.parse(userJson);
    },

    logout() {
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(LAST_ACTIVITY_KEY);
        location.reload();
    },

    async checkAccess() {
        const user = this.getCurrentUser();
        if (!user) {
            // 如果沒登入，且當前頁面不是閱讀器，則導向登入
            if (!window.location.search.includes('book=')) {
                this.showLoginOverlay();
                return false;
            }
        }
        return true;
    },

    showLoginOverlay() {
        // 建立一個覆蓋全螢幕的登入畫面
        if (document.getElementById('auth-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'auth-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:#12100a;z-index:9999;display:flex;align-items:center;justify-content:center;font-family:serif;';
        overlay.innerHTML = `
            <div style="background:#1c1810;padding:40px;border-radius:20px;border:1px solid #ffffff0c;width:320px;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,0.5);">
                <img src="logo.svg" alt="鑫囍探索旅行" style="height:40px;margin:0 auto 15px;display:block;">
                <p style="color:#ffffff22;font-size:0.7rem;letter-spacing:2px;margin-bottom:30px;text-transform:uppercase;">電子手冊管理</p>
                <div id="login-err" style="display:none;color:#e74c3c;font-size:0.75rem;margin-bottom:15px;background:rgba(231,76,60,0.1);padding:8px;border-radius:6px;"></div>
                <input type="text" id="auth-id" placeholder="員工編號" style="width:100%;background:#ffffff08;border:1px solid #ffffff0c;padding:12px;color:#f5f0e8;border-radius:10px;margin-bottom:12px;outline:none;">
                <input type="password" id="auth-pw" placeholder="登入密碼" style="width:100%;background:#ffffff08;border:1px solid #ffffff0c;padding:12px;color:#f5f0e8;border-radius:10px;margin-bottom:20px;outline:none;">
                <button id="auth-btn" style="width:100%;padding:13px;background:linear-gradient(135deg, #c8a96e, #a07840);color:#1a1208;border:none;border-radius:12px;font-weight:700;cursor:pointer;">登入系統</button>
            </div>
        `;
        document.body.appendChild(overlay);

        const btn = document.getElementById('auth-btn');
        const idInp = document.getElementById('auth-id');
        const pwInp = document.getElementById('auth-pw');
        const errBox = document.getElementById('login-err');

        const doLogin = async () => {
            btn.disabled = true;
            btn.textContent = '驗證中...';
            errBox.style.display = 'none';

            const result = await this.login(idInp.value, pwInp.value);
            if (result.success) {
                location.reload();
            } else {
                errBox.textContent = result.message;
                errBox.style.display = 'block';
                btn.disabled = false;
                btn.textContent = '登入系統';
            }
        };

        btn.onclick = doLogin;
        [idInp, pwInp].forEach(inp => inp.onkeydown = e => { if (e.key === 'Enter') doLogin(); });
    }
};

// 自動執行檢查 (排除閱讀器模式)
window.addEventListener('DOMContentLoaded', () => {
    if (!window.location.search.includes('book=')) {
        window.auth.checkAccess();
    }
});
