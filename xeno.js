if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { MongoClient } = require('mongodb');

const app = express();

const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://xenostia.vercel.app/callback';

const HACK_SCRIPT_PATH = path.join(__dirname, 'xenosigma.js'); 
const BYTEBUFFER_PATH = path.join(__dirname, 'bytebuffer.min.js'); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// 🗄️ CẤU HÌNH KẾT NỐI MONGODB TỐI ƯU CHO SERVERLESS
const client = new MongoClient(process.env.MONGODB_URI);
let cachedDb = null;
let cachedCollection = null;

async function connectDB() {
    if (cachedDb && cachedCollection) {
        return { db: cachedDb, configCollection: cachedCollection };
    }

    try {
        await client.connect();
        const db = client.db('xenostia_db');
        const configCollection = db.collection('system_data');
        
        const existing = await configCollection.findOne({ _id: 'main_config' });
        if (!existing) {
            await configCollection.insertOne({
                _id: 'main_config',
                users: {},
                whitelist: {},
                blacklist: {},
                maintenance: false,   // Thêm mặc định trạng thái bảo trì
                announcement: ""     // Thêm mặc định thông báo từ admin
            });
            console.log("👉 Đã tạo dữ liệu gốc trên MongoDB");
        } else {
            // Tự động bổ sung cấu trúc trường cũ nếu thiếu sót
            let updates = {};
            if (!existing.hasOwnProperty('maintenance')) updates.maintenance = false;
            if (!existing.hasOwnProperty('announcement')) updates.announcement = "";
            if (Object.keys(updates).length > 0) {
                await configCollection.updateOne({ _id: 'main_config' }, { $set: updates });
            }
        }

        cachedDb = db;
        cachedCollection = configCollection;
        
        return { db, configCollection };
    } catch (err) {
        console.error("❌ Thất bại khi kết nối MongoDB:", err);
        throw err;
    }
}

async function getSystemData() {
    const { configCollection } = await connectDB();
    return await configCollection.findOne({ _id: 'main_config' });
}

async function updateSystemData(newData) {
    const { configCollection } = await connectDB();
    await configCollection.updateOne({ _id: 'main_config' }, { $set: newData });
}

async function isWhitelisted(userId) {
    const data = await getSystemData();
    return data.whitelist.hasOwnProperty(userId);
}

async function isBlacklisted(userId) {
    const data = await getSystemData();
    return data.blacklist.hasOwnProperty(userId);
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

    try {
        const params = new URLSearchParams();
        params.append('client_id', CLIENT_ID);
        params.append('client_secret', CLIENT_SECRET);
        params.append('grant_type', 'authorization_code');
        params.append('code', code);
        params.append('redirect_uri', REDIRECT_URI);

        const tokenResponse = await axios.post(
            'https://discord.com/api/oauth2/token', 
            params.toString(),
            { 
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'DiscordBot (https://github.com/vaxil, 1.0.0)'
                } 
            }
        );

        const accessToken = tokenResponse.data.access_token;
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const userData = userResponse.data;
        const avatarUrl = userData.avatar 
            ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
            : `https://cdn.discordapp.com/embed/avatars/${userData.id % 5}.png`;

        if (await isBlacklisted(userData.id)) {
            return res.send(`
                <script>
                    alert("🚨 Tài khoản này đã bị cấm vĩnh viễn khỏi hệ thống!");
                    window.close();
                </script>
            `);
        }

        const data = await getSystemData();
        if (!data.users[userData.id]) {
            data.users[userData.id] = {
                username: userData.username,
                approved: false, 
                time: new Date().toLocaleString()
            };
            await updateSystemData({ users: data.users });
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
                        window.opener.postMessage(authData, 'https://zombs.io');
                        window.close();
                    } else {
                        document.body.innerHTML = "<h2 style='color:green; text-align:center;'>Đăng nhập xong! Bạn có thể tắt tab này và tải lại game.</h2>";
                    }
                </script>
            </body>
            </html>
        `);
    } catch (error) {
        console.error("Lỗi OAuth2 Chi tiết:", error.response ? error.response.data : error.message);
        res.status(500).send("Quá trình trao đổi mã xác thực Discord thất bại.");
    }
});

// ⚡ API CHECK TRẠNG THÁI SERVER CHUNG (Cho khách hoặc khi chưa đăng nhập)
app.get('/api/server-status', async (req, res) => {
    try {
        const data = await getSystemData();
        res.json({
            maintenance: data.maintenance || false,
            announcement: data.announcement || ""
        });
    } catch (e) {
        res.json({ maintenance: false, announcement: "" });
    }
});

// 🕒 API TUẦN TRA REAL-TIME CỦA USER ĐANG ONLINE
app.get('/api/heartbeat', async (req, res) => {
    const userId = req.query.id;
    const data = await getSystemData();
    const globalStatus = {
        maintenance: data.maintenance || false,
        announcement: data.announcement || ""
    };

    if (!userId) return res.json({ approved: false, ...globalStatus });

    if (await isBlacklisted(userId)) {
        return res.json({ approved: false, blacklist: true, ...globalStatus });
    }
    if (await isWhitelisted(userId)) {
        return res.json({ approved: true, ...globalStatus });
    }

    if (data.users[userId] && data.users[userId].approved === true) {
        return res.json({ approved: true, ...globalStatus });
    }

    res.json({ approved: false, blacklist: false, ...globalStatus });
});

app.get('/api/check-user', async (req, res) => {
    const userId = req.query.id;
    if (!userId) return res.json({ approved: false });

    if (await isBlacklisted(userId)) {
        return res.json({ approved: false, blacklist: true, message: "Bị thu hồi quyền vĩnh viễn!" });
    }

    const data = await getSystemData();

    if (data.whitelist.hasOwnProperty(userId)) {
        if (!data.users[userId]) data.users[userId] = { username: "User Whitelist", time: new Date().toLocaleString() };
        data.users[userId].approved = true;
        await updateSystemData({ users: data.users });
    }

    if (data.users[userId] && data.users[userId].approved === true) {
        if (fs.existsSync(HACK_SCRIPT_PATH)) {
            return res.json({ approved: true, script: fs.readFileSync(HACK_SCRIPT_PATH, 'utf8') });
        }
        return res.json({ approved: true, message: "Thiếu hack_script.js", script: "" });
    }
    res.json({ approved: false, blacklist: false, message: "Chờ phê duyệt." });
});

// DASHBOARD HỆ THỐNG QUẢN LÝ
app.get('/admin', async (req, res) => {
    const password = req.query.pwd;

    if (!password || password !== ADMIN_PASSWORD) {
        return res.status(403).send(`
            <style>body { background: #1e1e24; color: #ff5555; font-family: sans-serif; text-align: center; padding-top: 100px; }</style>
            <h2>🚫 TRUY CẬP BỊ TỪ CHỐI 🚫</h2>
            <p>Bạn không có quyền hạn truy cập vào hệ thống điều hành này!</p>
        `);
    }

    const data = await getSystemData();
    const usersData = data.users;
    const whitelistData = data.whitelist;
    const blacklistData = data.blacklist;
    const isMaintenance = data.maintenance || false;
    const currentAnnouncement = data.announcement || "";

    let rowsUsers = '';
    for (const [id, user] of Object.entries(usersData)) {
        if (blacklistData.hasOwnProperty(id)) continue;

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

    let rowsWhitelist = '';
    for (const [id, name] of Object.entries(whitelistData)) {
        rowsWhitelist += `<tr class="table-info"><td><code>${id}</code></td><td><b>👑 ${name}</b></td><td><button class="btn btn-danger btn-sm fw-bold" onclick="removeFromWhitelist('${id}')">🚫 GỠ VIP</button></td></tr>`;
    }

    let rowsBlacklist = '';
    for (const [id, name] of Object.entries(blacklistData)) {
        rowsBlacklist += `<tr class="table-danger text-dark"><td><code>${id}</code></td><td><b>💀 ${name}</b></td><td><button class="btn btn-success btn-sm fw-bold" onclick="unbanUser('${id}')">Ân Xá</button></td></tr>`;
    }

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Xenostia Control Panel v5.0</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        <style>body { background-color: #121214; color: #fff; } .card { background-color: #1a1a24; border: none; color: #fff; }</style>
    </head>
    <body>
        <div class="container-fluid px-5 py-4">
            <h2 class="text-center text-warning mb-4">🛡️ BẢNG ĐIỀU HÀNH TRUNG TÂM XENOSTIA 🛡️</h2>
            
            <div class="card p-4 mb-4 border border-warning">
                <h3 class="text-warning border-bottom pb-2">⚙️ Trạng Thái Máy Chủ Máy Chủ & Thông Báo Khẩn</h3>
                <div class="row align-items-center g-3">
                    <div class="col-md-3">
                        <label class="form-label fw-bold">Chế độ bảo trì hệ thống:</label>
                        <div class="form-check form-switch fs-4">
                            <input class="form-check-input" type="checkbox" id="maintenance_switch" ${isMaintenance ? 'checked' : ''} onchange="changeMaintenanceStatus()">
                            <span class="badge ${isMaintenance ? 'bg-danger' : 'bg-success'} fs-6" id="maint_badge">${isMaintenance ? 'ĐANG BẢO TRÌ' : 'HOẠT ĐỘNG'}</span>
                        </div>
                    </div>
                    <div class="col-md-9">
                        <label class="form-label fw-bold">Nội dung thông báo phát từ Admin:</label>
                        <div class="input-group">
                            <input type="text" id="announcement_input" class="form-control" placeholder="Nhập dòng chữ thông báo gửi tới giao diện hack..." value="${currentAnnouncement}">
                            <button class="btn btn-warning fw-bold" onclick="updateAnnouncement()">Phát Thông Báo</button>
                        </div>
                    </div>
                </div>
            </div>

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

            function changeMaintenanceStatus() {
                const isChecked = document.getElementById('maintenance_switch').checked;
                fetch('/api/system-settings?pwd=' + currentPwd, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: 'maintenance', value: isChecked })
                }).then(() => location.reload());
            }

            function updateAnnouncement() {
                const msg = document.getElementById('announcement_input').value;
                fetch('/api/system-settings?pwd=' + currentPwd, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: 'announcement', value: msg })
                }).then(() => alert("Đã cập nhật dòng thông báo khẩn!"));
            }

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
app.get('/changelog', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Xenostia - Changelog</title>
        <link href="https://fonts.googleapis.com/css2?family=Hammersmith+One&family=Lexend:wght@300;400;600&display=swap" rel="stylesheet">
        <style>
            @keyframes changelogShimmer {
                0% { background-position: 0% 50% !important; }
                100% { background-position: 100% 50% !important; }
            }

            body {
                background-color: #0c0c0e;
                color: #e2e8f0;
                font-family: 'Lexend', sans-serif;
                margin: 0;
                padding: 40px 20px;
                display: flex;
                flex-direction: column;
                align-items: center;
                min-height: 100vh;
            }

            .container {
                max-width: 650px;
                width: 100%;
                background: #141418;
                border: 1px solid #22222a;
                border-radius: 12px;
                padding: 30px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            }

            /* Bộ chọn ngôn ngữ tiện lợi */
            .lang-selector {
                display: flex;
                justify-content: center;
                gap: 10px;
                margin-bottom: 25px;
            }

            .lang-btn {
                background: #1e1e24;
                border: 1px solid #33333c;
                color: #94a3b8;
                padding: 8px 16px;
                border-radius: 6px;
                cursor: pointer;
                font-family: 'Lexend', sans-serif;
                font-weight: 500;
                transition: all 0.2s ease;
            }

            .lang-btn:hover {
                border-color: #ffaa00;
                color: #fff;
            }

            .lang-btn.active {
                background: #ffaa00;
                color: #000;
                border-color: #ffaa00;
                font-weight: 600;
                box-shadow: 0 0 12px rgba(255, 170, 0, 0.3);
            }

            /* Khung nội dung Changelog */
            .changelog-content {
                display: none;
                line-height: 1.6;
            }

            .changelog-content.active {
                display: block;
            }

            /* Tiêu đề Shimmer lấp lánh đặc trưng */
            .shimmer-title {
                text-align: center; 
                color: #ffffff; 
                font-family: 'Hammersmith One', sans-serif;
                padding: 10px 25px;
                margin: 15px auto 25px auto;
                border-radius: 8px;
                -webkit-text-stroke: 1.2px #ffffff;
                text-stroke: 1.2px #ffffff;
                display: table !important; 
                background: linear-gradient(110deg, #050505 0%, #1a1a1a 35%, rgba(255, 255, 255, 0.75) 50%, #333333 65%, #4a4a4a 100%) !important;
                background-size: 300% 100% !important;
                animation: changelogShimmer 2.5s ease-in-out infinite alternate !important;
            }

            hr {
                border: 0;
                height: 1px;
                background: #2d2d3a;
                margin: 20px 0;
            }

            ul {
                padding-left: 20px;
            }

            li {
                margin-bottom: 8px;
                color: #cbd5e1;
            }

            strong {
                color: #fff;
            }
        </style>
    </head>
    <body>

        <div class="container">
            <div class="lang-selector">
                <button class="lang-btn active" onclick="switchLang('vi')">Tiếng Việt</button>
                <button class="lang-btn" onclick="switchLang('en')">English</button>
                <button class="lang-btn" onclick="switchLang('hk')">繁體中文</button>
            </div>

            <!-- TIẾNG VIỆT -->
            <div id="lang-vi" class="changelog-content active">
                <h2 class="shimmer-title">📋 Nhật Ký Thay Đổi</h2>
                <p><strong>🧩 Ngày cập nhật:</strong> 11/06/2026</p>
                <p><strong>📏 Số dòng lệnh đạt được:</strong> 9294+ lines</p>
                <hr>
                <p><strong>🔧 Sửa lỗi & Tối ưu hóa:</strong></p>
                <ul>
                    <li>[MỚI] Sửa lỗi hệ thống quét máy chủ (server scanner)</li>
                    <li>Sửa lỗi hiển thị số lượng người chơi trên server (server population)</li>
                    <li>Sửa lỗi hệ thống tài khoản phụ (Alts) và lỗi hiển thị HUD của Alts</li>
                    <li>Sửa lỗi hiển thị Thương (Spear) khi chơi alts</li>
                    <li>Xử lý triệt để lỗi bộ dựng hình (renderer bug) và lỗi WASM trên tài khoản phụ</li>
                    <li>Chuyển đổi hiệu ứng thông báo từ "phải sang trái" thành "từ trên xuống" cho mượt hơn</li>
                    <li>Sửa lỗi hiển thị thu phóng (zoom) và hiển thị các con số trên alts</li>
                    <li>Tối ưu hóa WASM giúp alts truyền tải dữ liệu mượt mà, không bị delay</li>
                    <li>Xóa tài khoản phụ (Alt) giờ đây cực nhanh, gần như tức thì!</li>
                    <li>Sửa lỗi mất kết nối (disconnect) gây đơ hoặc văng/sập màn hình</li>
                    <li>Sửa giới hạn RAM (RAM limit) giúp tối ưu hóa hiệu năng toàn hệ thống</li>
                    <li>Tối ưu cấu trúc HTML của giao diện cửa hàng (Shop Layout)</li>
                    <li>Sửa lỗi phím bấm nhanh (Xkey) cho bom (Bomb), cung (Bow) và thương (Spear)</li>
                    <li>Sửa lỗi và cải tiến hệ thống tự động ngắm (Aim assist)</li>
                </ul>
                <p><strong>✨ Tính năng mới:</strong></p>
                <ul>
                    <li>Tích hợp tính năng mới UTH</li>
                    <li>Đã có thể trực tiếp theo dõi nguyên liệu/tài nguyên của alts ngay trong phần Cài đặt (Settings)</li>
                    <li>Gỡ bỏ tùy chọn cũ 'send res alts' để tối ưu hóa hoàn toàn không gian menu Cài đặt</li>
                    <li>Thêm cơ chế click để tự thoát menu nhanh khi bị kẹt giao diện</li>
                    <li>Thêm hiệu ứng viền màn hình nhấp nháy đỏ khi rơi vào trạng thái thấp máu (Low heart effect)</li>
                    <li>Cấu trúc lại toàn bộ HTML của thanh máu (Health) và giáp (Shield) để tối ưu hiển thị</li>
                    <li>Thay đổi cách hiển thị chỉ số server (Server stats) trực quan, chi tiết và rõ ràng hơn</li>
                    <li>Thêm tính năng tự động mua thương khi đi raid riêng cho chế độ 1b1 (Auto buy spear raid for 1b1)</li>
                    <li>Bổ sung hàm helper xử lý khoảng giữa uth và ahrc</li>
                    <li>Thêm tính năng phím ] dành riêng cho raid 1b1 alt</li>
                    <li>Tính năng chọn map sẽ di chuyển tới khu vực đó</li>
                    <li>Cải thiện chế độ Spectate (Spectate mode)</li>
                    <li>Cải thiện tính năng tự động hồi sinh alt (Auto respawn alt)</li>
                    <li>Đã fix xkey bomb, spear, bow (Cần bật auto respawn để alt tự mua bow)</li>
                    <li>Xóa bỏ thông báo HUD intro khi vào server</li>
                </ul>
                <p><strong>🔮 Sắp ra mắt:</strong></p>
                <ul>
                    <li>Hệ thống phiên làm việc / Session system (quá khó)</li>
                </ul>
            </div>

            <!-- ENGLISH -->
            <div id="lang-en" class="changelog-content">
                <h2 class="shimmer-title">📋 Changelog</h2>
                <p><strong>🧩 Update Date:</strong> 11/06/2026</p>
                <p><strong>📏 Code Lines Reached:</strong> 9294+ lines</p>
                <hr>
                <p><strong>🔧 Fixes & Optimization:</strong></p>
                <ul>
                    <li>[NEW] Fixed server scanner system</li>
                    <li>Fixed server population display bug</li>
                    <li>Fixed Alts system and Alts HUD display issues</li>
                    <li>Fixed Spear display bug when playing on alts</li>
                    <li>Completely resolved renderer bug and WASM errors on alts</li>
                    <li>Changed notification animation from right-to-left to top-down for smoother transition</li>
                    <li>Fixed zoom and number display issues on alts</li>
                    <li>Optimized WASM for smoother alt data transmission without delay</li>
                    <li>Deleting alts is now extremely fast, practically instant!</li>
                    <li>Fixed disconnection issues causing screen freezing or crashes</li>
                    <li>Fixed RAM limit to optimize entire system performance</li>
                    <li>Optimized HTML structure for the Shop Layout</li>
                    <li>Fixed quick-key (Xkey) for Bomb, Bow, and Spear</li>
                    <li>Fixed and improved Aim Assist system</li>
                </ul>
                <p><strong>✨ New Features:</strong></p>
                <ul>
                    <li>Integrated new UTH feature</li>
                    <li>Added ability to track alt materials/resources directly in Settings</li>
                    <li>Removed 'send res alts' option to fully optimize Settings menu space</li>
                    <li>Added a click-to-exit option to quickly close the interface if stuck</li>
                    <li>Added low health border flashing red effect (Low heart effect)</li>
                    <li>Restructured entire HTML for Health and Shield bars for optimal display</li>
                    <li>Changed server stats display to be more intuitive, detailed, and clear</li>
                    <li>Added auto-buy spear for raids, exclusively for 1b1 mode</li>
                    <li>Added helper function to handle the gap between UTH and AHRC</li>
                    <li>Added ] hotkey feature dedicated to 1b1 alt raids</li>
                    <li>Map selection feature now teleports to the selected area</li>
                    <li>Improved Spectate mode</li>
                    <li>Improved auto-respawn for alts</li>
                    <li>Fixed Xkey for Bomb, Spear, and Bow (Requires auto-respawn for alts to buy Bow)</li>
                    <li>Removed HUD intro notification upon entering the server</li>
                </ul>
                <p><strong>🔮 Coming Soon:</strong></p>
                <ul>
                    <li>Session system (too hard)</li>
                </ul>
            </div>

            <!-- HONG KONG (繁體中文) -->
            <div id="lang-hk" class="changelog-content">
                <h2 class="shimmer-title">📋 更新日誌</h2>
                <p><strong>🧩 更新日期:</strong> 11/06/2026</p>
                <p><strong>📏 代碼行數已達:</strong> 9294+ 行</p>
                <hr>
                <p><strong>🔧 修正與優化:</strong></p>
                <ul>
                    <li>[全新] 修復伺服器掃描系統 (server scanner)</li>
                    <li>修復伺服器人數顯示錯誤 (server population)</li>
                    <li>修復分帳系統 (Alts) 及分帳 HUD 顯示錯誤</li>
                    <li>修復在分帳上遊玩時的長槍 (Spear) 顯示錯誤</li>
                    <li>徹底解決分帳上的渲染器錯誤 (renderer bug) 及 WASM 錯誤</li>
                    <li>將通知動畫從「右至左」改為「從上至下」，運作更流暢</li>
                    <li>修復分帳的縮放與數字顯示錯誤</li>
                    <li>優化 WASM，讓分帳數據傳輸更流暢、零延遲</li>
                    <li>刪除分帳速度極快，幾乎瞬間完成！</li>
                    <li>修復斷線時導致畫面卡死、凍結或崩潰的問題</li>
                    <li>修正記憶體限制 (RAM limit)，優化全系統效能</li>
                    <li>優化商店介面 (Shop Layout) 的 HTML 結構</li>
                    <li>修復炸彈 (Bomb)、弓箭 (Bow) 及長槍 (Spear) 的快捷鍵 (Xkey)</li>
                    <li>修復並改進自動 aim 輔助系統 (Aim assist)</li>
                </ul>
                <p><strong>✨ 新功能:</strong></p>
                <ul>
                    <li>整合全新 UTH 功能</li>
                    <li>新增可直接在設定 (Settings) 中查看分帳材料/資源的功能</li>
                    <li>移除舊有的 'send res alts' 選項，以徹底釋放設定選單空間</li>
                    <li>新增點擊機制，當介面卡住時可快速強制退出選單</li>
                    <li>新增低血量時螢幕邊框閃爍紅光的特效 (Low heart effect)</li>
                    <li>重構血量條 (Health) 與護甲條 (Shield) 的 HTML 結構以優化顯示</li>
                    <li>改變伺服器數據 (Server stats) 的顯示方式，更直觀、詳細且清晰</li>
                    <li>新增 1b1 模式專用的突襲自動購買長槍功能 (Auto buy spear raid for 1b1)</li>
                    <li>新增處理 uth 與 ahrc 之間間距的 helper 函數</li>
                    <li>新增專屬於 1b1 分帳突襲的 ] 鍵功能</li>
                    <li>地圖選擇功能現在會直接傳送到該區域</li>
                    <li>改進觀戰模式 (Spectate mode)</li>
                    <li>改進分帳自動復活功能 (Auto respawn alt)</li>
                    <li>已修復炸彈、長槍、弓箭的 Xkey (需要開啟 auto respawn 以便分帳購買弓箭)</li>
                    <li>移除了進入伺服器時的 HUD intro 歡迎通知</li>
                </ul>
                <p><strong>🔮 即將推出:</strong></p>
                <ul>
                    <li>會話系統 / Session system (太難了)</li>
                </ul>
            </div>
        </div>

        <script>
            function switchLang(langCode) {
                // 1. Ẩn tất cả các tab nội dung
                document.querySelectorAll('.changelog-content').forEach(el => {
                    el.classList.remove('active');
                });
                // 2. Tắt trạng thái active của tất cả các nút bấm
                document.querySelectorAll('.lang-btn').forEach(btn => {
                    btn.classList.remove('active');
                });
                
                // 3. Hiển thị tab và kích hoạt nút tương ứng
                document.getElementById('lang-' + langCode).classList.add('active');
                event.currentTarget.classList.add('active');
            }
        </script>
    </body>
    </html>
    `);
});
// 🛠️ API ĐIỀU CHỈNH CẤU HÌNH HỆ THỐNG
app.post('/api/system-settings', async (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).json({ error: "No permission" });
    
    const { key, value } = req.body;
    if (key === 'maintenance' || key === 'announcement') {
        let updateObj = {};
        updateObj[key] = value;
        await updateSystemData(updateObj);
        return res.json({ success: true });
    }
    res.status(400).json({ error: "Invalid key" });
});

app.post('/api/toggle-approve', async (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).json({ error: "No permission" });
    
    const userId = req.body.id;
    const data = await getSystemData();
    if (data.users[userId]) { 
        data.users[userId].approved = !data.users[userId].approved; 
        await updateSystemData({ users: data.users });
    }
    res.json({ success: true });
});

app.post('/api/manage-whitelist', async (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).json({ error: "No permission" });

    const { id, name, action } = req.body;
    const data = await getSystemData();

    if (action === 'add') data.whitelist[id] = name;
    else if (action === 'remove') { 
        delete data.whitelist[id]; 
        if (data.users[id]) data.users[id].approved = false; 
    }
    await updateSystemData({ whitelist: data.whitelist, users: data.users });
    res.json({ success: true });
});

app.post('/api/manage-blacklist', async (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).json({ error: "No permission" });

    const { id, name, action } = req.body;
    const data = await getSystemData();

    if (action === 'ban') {
        data.blacklist[id] = name || "Bị cấm";
        if (data.users[id]) data.users[id].approved = false; 
    } else if (action === 'unban') {
        delete data.blacklist[id];
    }

    await updateSystemData({ blacklist: data.blacklist, users: data.users });
    res.json({ success: true });
});

module.exports = app;