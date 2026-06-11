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