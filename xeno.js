require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const app = express();
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
// Thay đổi định nghĩa đường dẫn file sang thư mục /tmp
const USERS_FILE = path.join('/tmp', 'users.json');
const WHITELIST_FILE = path.join('/tmp', 'whitelist.json');
const BLACKLIST_FILE = path.join('/tmp', 'blacklist.json');
const HACK_SCRIPT_PATH = path.join(__dirname, 'xenosigma.js'); // Giữ nguyên file code đọc
const BYTEBUFFER_PATH = path.join(__dirname, 'bytebuffer.min.js'); // Giữ nguyên file code đọc
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://xenostia21.onrender.com/callback';
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// Khởi tạo các file database nếu chưa tồn tại
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}', 'utf8');
if (!fs.existsSync(WHITELIST_FILE)) fs.writeFileSync(WHITELIST_FILE, '{}', 'utf8');
if (!fs.existsSync(BLACKLIST_FILE)) fs.writeFileSync(BLACKLIST_FILE, '{}', 'utf8');

function isWhitelisted(userId) {
    const whitelist = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
    return whitelist.hasOwnProperty(userId);
}

function isBlacklisted(userId) {
    const blacklist = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
    return blacklist.hasOwnProperty(userId);
}

// 📦 API PHÂN PHỐI BYTEBUFFER LOCAL
app.get('/libs/bytebuffer.min.js', (req, res) => {
    if (fs.existsSync(BYTEBUFFER_PATH)) {
        res.setHeader('Content-Type', 'application/javascript');
        return res.sendFile(BYTEBUFFER_PATH);
    }
    axios.get("https://raw.githubusercontent.com/dcodeIO/ByteBuffer.js/master/dist/bytebuffer.min.js")
        .then(response => {
            fs.writeFileSync(BYTEBUFFER_PATH, response.data, 'utf8');
            res.setHeader('Content-Type', 'application/javascript');
            res.send(response.data);
        })
        .catch(() => res.status(500).send("Không thể tải ByteBuffer"));
});

app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send("Không tìm thấy Code xác thực.");

    // 🛠️ THÊM ĐOẠN LOG ĐỂ KIỂM TRA PAYLOAD TẠI ĐÂY:
    console.log("Payload gửi đến Discord:", {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET ? "Đã có secret" : "MISSING",
        code: code,
        redirect_uri: REDIRECT_URI
    });

    try {
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI,
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        const accessToken = tokenResponse.data.access_token;

        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const userData = userResponse.data;
        const avatarUrl = userData.avatar 
            ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
            : `https://cdn.discordapp.com/embed/avatars/${userData.id % 5}.png`;

        // Nếu nằm trong danh sách đen, xử lý chặn ngay từ bước đăng nhập
        if (isBlacklisted(userData.id)) {
            return res.send(`
                <script>
                    alert("🚨 Tài khoản này đã bị cấm vĩnh viễn khỏi hệ thống!");
                    window.close();
                </script>
            `);
        }

        let usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        if (!usersData[userData.id]) {
            usersData[userData.id] = {
                username: userData.username,
                approved: false, 
                time: new Date().toLocaleString()
            };
            fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2), 'utf8');
        }

        res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>Đang xác thực...</title></head>
            <body>
                <h3 style="text-align:center; font-family:sans-serif; margin-top:50px;">Xác thực thành công! Đang đồng bộ hóa dữ liệu...</h3>
                <script>
                    const authData = {
                        type: 'DISCORD_LOGIN_SUCCESS',
                        id: '${userData.id}',
                        username: '${userData.username}',
                        avatar: '${avatarUrl}'
                    };
                    if (window.opener) {
                        window.opener.postMessage(authData, '*');
                        window.close();
                    } else {
                        document.body.innerHTML = "<h2 style='color:green; text-align:center;'>Đăng nhập xong! Bạn có thể tắt tab này và tải lại game.</h2>";
                    }
                </script>
            </body>
            </html>
        `);
    } catch (error) {
        console.error("Lỗi OAuth2:", error.response ? error.response.data : error.message);
        res.status(500).send("Quá trình trao đổi mã xác thực Discord thất bại.");
    }
});

app.get('/api/heartbeat', (req, res) => {
    const userId = req.query.id;
    if (!userId) return res.json({ approved: false });

    // 1. Kiểm tra danh sách đen / danh sách trắng cứng trước
    if (isBlacklisted(userId)) {
        return res.json({ approved: false, blacklist: true });
    }
    if (isWhitelisted(userId)) {
        return res.json({ approved: true });
    }

    // 2. Kiểm tra trạng thái lưu trong tệp tin users.json
    try {
        const usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        if (usersData[userId] && usersData[userId].approved === true) {
            return res.json({ approved: true });
        }
    } catch (e) {
        console.error("Lỗi đọc file cấu trúc dữ liệu người dùng:", e);
    }

    res.json({ approved: false, blacklist: false });
});
// API lấy script hack ban đầu
app.get('/api/check-user', (req, res) => {
    const userId = req.query.id;
    if (!userId) return res.json({ approved: false });

    if (isBlacklisted(userId)) {
        return res.json({ approved: false, blacklist: true, message: "Bị thu hồi quyền vĩnh viễn!" });
    }

    let usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));

    if (isWhitelisted(userId)) {
        if (!usersData[userId]) usersData[userId] = { username: "User Whitelist", time: new Date().toLocaleString() };
        usersData[userId].approved = true;
        fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2), 'utf8');
    }

    if (usersData[userId] && usersData[userId].approved === true) {
        if (fs.existsSync(HACK_SCRIPT_PATH)) {
            return res.json({ approved: true, script: fs.readFileSync(HACK_SCRIPT_PATH, 'utf8') });
        }
        return res.json({ approved: true, message: "Thiếu hack_script.js", script: "" });
    }
    res.json({ approved: false, blacklist: false, message: "Chờ phê duyệt." });
});

// DASHBOARD HỆ THỐNG QUẢN LÝ 
app.get('/admin', (req, res) => {
    const password = req.query.pwd;

    if (!password || password !== ADMIN_PASSWORD) {
        return res.status(403).send(`
            <style>body { background: #1e1e24; color: #ff5555; font-family: sans-serif; text-align: center; padding-top: 100px; }</style>
            <h2>🚫 TRUY CẬP BỊ TỪ CHỐI 🚫</h2>
            <p>Bạn không có quyền hạn truy cập vào hệ thống điều hành này!</p>
        `);
    }

    const usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    const whitelistData = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
    const blacklistData = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));

    // Render danh sách người dùng (Chỉ hiện những ai KHÔNG nằm trong blacklist)
    let rowsUsers = '';
    for (const [id, user] of Object.entries(usersData)) {
        if (blacklistData.hasOwnProperty(id)) continue; // Ẩn hoàn toàn khỏi danh sách online/chờ duyệt thông thường

        const badgeColor = user.approved ? 'success' : 'secondary';
        const badgeText = user.approved ? 'Đã cấp quyền' : 'Chờ duyệt';
        const btnColor = user.approved ? 'btn-outline-warning' : 'btn-success';
        const btnText = user.approved ? 'Thu hồi quyền' : 'Duyệt nhanh';
        
        rowsUsers += `
        <tr>
            <td><code>${id}</code></td>
            <td><b>${user.username}</b></td>
            <td><span class="badge bg-${badgeColor}">${badgeText}</span></td>
            <td>
                <button class="btn ${btnColor} btn-sm me-1" onclick="toggleApprove('${id}')">${btnText}</button>
                <button class="btn btn-danger btn-sm" onclick="banUser('${id}', '${user.username}')">Ban Vĩnh Viễn</button>
            </td>
        </tr>`;
    }

    // Render danh sách Whitelist VIP
    let rowsWhitelist = '';
    for (const [id, name] of Object.entries(whitelistData)) {
        rowsWhitelist += `<tr class="table-info"><td><code>${id}</code></td><td><b>👑 ${name}</b></td><td><button class="btn btn-danger btn-sm fw-bold" onclick="removeFromWhitelist('${id}')">🚫 GỠ VIP</button></td></tr>`;
    }

    // Render danh sách Blacklist
    let rowsBlacklist = '';
    for (const [id, name] of Object.entries(blacklistData)) {
        rowsBlacklist += `<tr class="table-danger text-dark"><td><code>${id}</code></td><td><b>💀 ${name}</b></td><td><button class="btn btn-success btn-sm fw-bold" onclick="unbanUser('${id}')">Ân Xá</button></td></tr>`;
    }

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Xenostia Control Panel v4.5</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        <style>body { background-color: #121214; color: #fff; } .card { background-color: #1a1a24; border: none; color: #fff; }</style>
    </head>
    <body>
        <div class="container-fluid px-5 py-4">
            <h2 class="text-center text-warning mb-4">🛡️ BẢNG ĐIỀU HÀNH TRUNG TÂM XENOSTIA 🛡️</h2>
            <div class="row g-4">
                <div class="col-lg-6">
                    <div class="card p-4 h-100">
                        <h3 class="text-info border-bottom pb-2">👥 Quản Lý Phiên Truy Cập</h3>
                        <div class="table-responsive">
                            <table class="table table-dark table-striped align-middle">
                                <thead><tr><th>Discord ID</th><th>Tên Người Dùng</th><th>Trạng thái</th><th>Hành động</th></tr></thead>
                                <tbody>${rowsUsers}</tbody>
                            </table>
                        </div>
                    </div>
                </div>
                <div class="col-lg-6">
                    <div class="row g-4">
                        <div class="col-12">
                            <div class="card p-4">
                                <h3 class="text-warning border-bottom pb-2">👑 VIP Whitelist (Auto Duyệt)</h3>
                                <div class="input-group input-group-sm mb-3">
                                    <input type="text" id="wl_id" class="form-control" placeholder="Discord ID...">
                                    <input type="text" id="wl_name" class="form-control" placeholder="Tên gợi nhớ...">
                                    <button class="btn btn-warning" onclick="addToWhitelist()">Thêm VIP</button>
                                </div>
                                <table class="table table-dark align-middle"><tbody>${rowsWhitelist}</tbody></table>
                            </div>
                        </div>
                        <div class="col-12">
                            <div class="card p-4 border border-danger">
                                <h3 class="text-danger border-bottom pb-2">💀 Blacklist (Thu hồi vĩnh viễn)</h3>
                                <div class="table-responsive">
                                    <table class="table table-dark align-middle">
                                        <thead><tr><th>ID</th><th>Tên</th><th>Hành động</th></tr></thead>
                                        <tbody>${rowsBlacklist}</tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <script>
            const currentPwd = new URLSearchParams(window.location.search).get('pwd') || '';

            function toggleApprove(id) { 
                fetch('/api/toggle-approve?pwd=' + currentPwd, { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ id }) 
                }).then(() => location.reload()); 
            }
            function addToWhitelist() { 
                const id = document.getElementById('wl_id').value; 
                const name = document.getElementById('wl_name').value; 
                fetch('/api/manage-whitelist?pwd=' + currentPwd, { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ id, name, action: 'add' }) 
                }).then(() => location.reload()); 
            }
            function removeFromWhitelist(id) { 
                fetch('/api/manage-whitelist?pwd=' + currentPwd, { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ id, action: 'remove' }) 
                }).then(() => location.reload()); 
            }
            function banUser(id, name) {
                if(confirm("Xác nhận khóa vĩnh viễn và đưa vào danh sách đen người dùng: " + name + "?")) {
                    fetch('/api/manage-blacklist?pwd=' + currentPwd, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id, name, action: 'ban' })
                    }).then(() => location.reload());
                }
            }
            function unbanUser(id) {
                if(confirm("Giải phóng tài khoản này khỏi danh sách đen?")) {
                    fetch('/api/manage-blacklist?pwd=' + currentPwd, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id, action: 'unban' })
                    }).then(() => location.reload());
                }
            }
        </script>
    </body>
    </html>`);
});

// PROTECTED API: BẢO VỆ DỮ LIỆU ĐỔI TRẠNG THÁI
app.post('/api/toggle-approve', (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).json({ error: "No permission" });
    
    const userId = req.body.id;
    let usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (usersData[userId]) { 
        usersData[userId].approved = !usersData[userId].approved; 
        fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2), 'utf8'); 
    }
    res.json({ success: true });
});

app.post('/api/manage-whitelist', (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).json({ error: "No permission" });

    const { id, name, action } = req.body;
    let whitelist = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
    let usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (action === 'add') whitelist[id] = name;
    else if (action === 'remove') { 
        delete whitelist[id]; 
        if (usersData[id]) usersData[id].approved = false; 
    }
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(whitelist, null, 2), 'utf8');
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2), 'utf8');
    res.json({ success: true });
});

// API QUẢN LÝ DANH SÁCH ĐEN (BLACKLIST)
app.post('/api/manage-blacklist', (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).json({ error: "No permission" });

    const { id, name, action } = req.body;
    let blacklist = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
    let usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));

    if (action === 'ban') {
        blacklist[id] = name || "Bị cấm";
        if (usersData[id]) usersData[id].approved = false; // Thu hồi quyền lập tức
    } else if (action === 'unban') {
        delete blacklist[id];
    }

    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(blacklist, null, 2), 'utf8');
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2), 'utf8');
    res.json({ success: true });
});
module.exports = app;
