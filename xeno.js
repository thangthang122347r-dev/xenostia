require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose'); // Thêm Mongoose
const app = express();

// --- CẤU HÌNH MONGODB ---
mongoose.connect(process.env.MONGODB_URI);

const DataSchema = new mongoose.Schema({
    _id: String,
    users: Object,
    whitelist: Object,
    blacklist: Object
});
const AppModel = mongoose.model('AppData', DataSchema);

// Hàm lấy dữ liệu (thay cho việc đọc file JSON)
async function getDB() {
    let doc = await AppModel.findById('main_config');
    if (!doc) {
        doc = new AppModel({ _id: 'main_config', users: {}, whitelist: {}, blacklist: {} });
        await doc.save();
    }
    return doc;
}

const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

const HACK_SCRIPT_PATH = path.join(__dirname, 'xenosigma.js'); 
const BYTEBUFFER_PATH = path.join(__dirname, 'bytebuffer.min.js'); 
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://xenostia.vercel.app/callback';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// Hàm logic giữ nguyên nhưng dùng async/await
async function isWhitelisted(userId) {
    const doc = await getDB();
    return doc.whitelist.hasOwnProperty(userId);
}

async function isBlacklisted(userId) {
    const doc = await getDB();
    return doc.blacklist.hasOwnProperty(userId);
}

// 📦 API PHÂN PHỐI BYTEBUFFER LOCAL (Giữ nguyên fs vì là file tĩnh)
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

        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', params.toString(), { 
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'DiscordBot' } 
        });

        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` }
        });

        const userData = userResponse.data;
        const avatarUrl = userData.avatar ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png` : `https://cdn.discordapp.com/embed/avatars/${userData.id % 5}.png`;

        if (await isBlacklisted(userData.id)) {
            return res.send(`<script>alert("🚨 Tài khoản này đã bị cấm!"); window.close();</script>`);
        }

        const doc = await getDB();
        if (!doc.users[userData.id]) {
            doc.users[userData.id] = { username: userData.username, approved: false, time: new Date().toLocaleString() };
            doc.markModified('users'); // Cực kỳ quan trọng khi dùng Mongoose với Object
            await doc.save();
        }

        res.send(`<!DOCTYPE html><html><body><script>const authData = { type: 'DISCORD_LOGIN_SUCCESS', id: '${userData.id}', username: '${userData.username}', avatar: '${avatarUrl}' }; if(window.opener){ window.opener.postMessage(authData, 'https://zombs.io'); window.close(); } else { document.body.innerHTML = "Đăng nhập xong!"; }</script></body></html>`);
    } catch (error) {
        res.status(500).send("Quá trình trao đổi mã xác thực Discord thất bại.");
    }
});

app.get('/api/heartbeat', async (req, res) => {
    const userId = req.query.id;
    if (!userId) return res.json({ approved: false });

    if (await isBlacklisted(userId)) return res.json({ approved: false, blacklist: true });
    if (await isWhitelisted(userId)) return res.json({ approved: true });

    const doc = await getDB();
    if (doc.users[userId] && doc.users[userId].approved === true) {
        return res.json({ approved: true });
    }
    res.json({ approved: false, blacklist: false });
});

app.get('/api/check-user', async (req, res) => {
    const userId = req.query.id;
    if (!userId) return res.json({ approved: false });

    if (await isBlacklisted(userId)) return res.json({ approved: false, blacklist: true, message: "Bị thu hồi quyền!" });

    const doc = await getDB();
    if (await isWhitelisted(userId)) {
        if (!doc.users[userId]) doc.users[userId] = { username: "User Whitelist", time: new Date().toLocaleString() };
        doc.users[userId].approved = true;
        doc.markModified('users');
        await doc.save();
    }

    if (doc.users[userId] && doc.users[userId].approved === true) {
        return res.json({ approved: true, script: fs.existsSync(HACK_SCRIPT_PATH) ? fs.readFileSync(HACK_SCRIPT_PATH, 'utf8') : "" });
    }
    res.json({ approved: false, blacklist: false, message: "Chờ phê duyệt." });
});

// DASHBOARD HỆ THỐNG QUẢN LÝ
app.get('/admin', async (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).send("🚫 Truy cập bị từ chối");

    const doc = await getDB();
    let rowsUsers = '';
    for (const [id, user] of Object.entries(doc.users)) {
        if (doc.blacklist.hasOwnProperty(id)) continue;
        const badgeColor = user.approved ? 'success' : 'secondary';
        rowsUsers += `<tr><td><code>${id}</code></td><td><b>${user.username}</b></td><td><span class="badge bg-${badgeColor}">${user.approved ? 'Đã cấp' : 'Chờ'}</span></td><td><button class="btn btn-sm ${user.approved ? 'btn-outline-warning' : 'btn-success'}" onclick="toggleApprove('${id}')">${user.approved ? 'Thu hồi' : 'Duyệt'}</button></td></tr>`;
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

app.post('/api/toggle-approve', async (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).json({ error: "No permission" });
    const doc = await getDB();
    if (doc.users[req.body.id]) { 
        doc.users[req.body.id].approved = !doc.users[req.body.id].approved; 
        doc.markModified('users');
        await doc.save(); 
    }
    res.json({ success: true });
});

app.post('/api/manage-whitelist', async (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).json({ error: "No permission" });
    const doc = await getDB();
    const { id, name, action } = req.body;
    if (action === 'add') doc.whitelist[id] = name;
    else if (action === 'remove') { delete doc.whitelist[id]; if (doc.users[id]) doc.users[id].approved = false; }
    doc.markModified('whitelist');
    doc.markModified('users');
    await doc.save();
    res.json({ success: true });
});

app.post('/api/manage-blacklist', async (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).json({ error: "No permission" });
    const doc = await getDB();
    const { id, name, action } = req.body;
    if (action === 'ban') { doc.blacklist[id] = name || "Bị cấm"; if (doc.users[id]) doc.users[id].approved = false; }
    else if (action === 'unban') { delete doc.blacklist[id]; }
    doc.markModified('blacklist');
    doc.markModified('users');
    await doc.save();
    res.json({ success: true });
});

module.exports = app;