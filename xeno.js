require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

// 1. KẾT NỐI MONGODB
mongoose.connect(process.env.MONGODB_URI);

const DataSchema = new mongoose.Schema({
    _id: String,
    users: Object,
    whitelist: Object,
    blacklist: Object
});
const DataModel = mongoose.model('AppData', DataSchema);

// Hàm lấy dữ liệu từ DB (Async)
async function getDB() {
    let doc = await DataModel.findById('main_config');
    if (!doc) {
        doc = new DataModel({ _id: 'main_config', users: {}, whitelist: {}, blacklist: {} });
        await doc.save();
    }
    return doc;
}

// 2. MIDDLEWARE & CẤU HÌNH
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://xenostia.vercel.app/callback';

// 3. CÁC HÀM XỬ LÝ LOGIC (Thay thế fs bằng MongoDB)
async function isWhitelisted(userId) {
    const doc = await getDB();
    return doc.whitelist.hasOwnProperty(userId);
}

async function isBlacklisted(userId) {
    const doc = await getDB();
    return doc.blacklist.hasOwnProperty(userId);
}

// 4. CÁC API ENDPOINTS
app.get('/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send("Không tìm thấy Code.");

    try {
        const params = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', params.toString());
        const userResponse = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` } });
        
        const userData = userResponse.data;
        if (await isBlacklisted(userData.id)) return res.send("<script>alert('Bị cấm!'); window.close();</script>");

        const doc = await getDB();
        if (!doc.users[userData.id]) {
            doc.users[userData.id] = { username: userData.username, approved: false, time: new Date().toLocaleString() };
            doc.markModified('users');
            await doc.save();
        }

        res.send(`<h3>Xác thực thành công!</h3><script>window.opener.postMessage({type:'DISCORD_LOGIN_SUCCESS', id:'${userData.id}'}, 'https://zombs.io'); window.close();</script>`);
    } catch (e) { res.status(500).send("Lỗi xác thực."); }
});

app.get('/api/check-user', async (req, res) => {
    const userId = req.query.id;
    if (!userId || await isBlacklisted(userId)) return res.json({ approved: false });

    const doc = await getDB();
    if (await isWhitelisted(userId)) {
        if (!doc.users[userId]) doc.users[userId] = { username: "User", time: new Date().toLocaleString() };
        doc.users[userId].approved = true;
        doc.markModified('users');
        await doc.save();
    }

    if (doc.users[userId]?.approved) {
        return res.json({ approved: true, script: "/* Nội dung script của ông */" });
    }
    res.json({ approved: false, message: "Chờ phê duyệt." });
});

// 5. DASHBOARD ADMIN (Giữ nguyên giao diện của ông)
app.get('/admin', async (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).send("Từ chối truy cập.");

    const doc = await getDB();
    let rowsUsers = '';
    for (const [id, user] of Object.entries(doc.users)) {
        if (doc.blacklist.hasOwnProperty(id)) continue;
        rowsUsers += `<tr><td>${id}</td><td>${user.username}</td><td>${user.approved ? 'Đã duyệt' : 'Chờ'}</td>
        <td><button onclick="toggle('${id}')">${user.approved ? 'Thu hồi' : 'Duyệt'}</button></td></tr>`;
    }
    
    res.send(`
        <html><body>
        <h2>Bảng điều khiển</h2>
        <table border="1">${rowsUsers}</table>
        <script>
            function toggle(id) {
                fetch('/api/toggle-approve?pwd=${ADMIN_PASSWORD}', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id })
                }).then(() => location.reload());
            }
        </script>
        </body></html>
    `);
});

// 6. CÁC API QUẢN LÝ (POST)
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

module.exports = app;