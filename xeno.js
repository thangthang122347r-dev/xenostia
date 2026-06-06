require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();

const client = new MongoClient(process.env.MONGODB_URI);
const dbName = "xenostia_db";
const COLLECTION = "system_data";

// Cấu hình
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
    res.header("Access-Control-Allow-Headers", "*");
    next();
});

// Hàm lấy dữ liệu từ MongoDB
async function getDB() {
    await client.connect();
    const db = client.db(dbName);
    let doc = await db.collection(COLLECTION).findOne({ _id: "config" });
    if (!doc) {
        doc = { _id: "config", users: {}, whitelist: {}, blacklist: {} };
        await db.collection(COLLECTION).insertOne(doc);
    }
    return doc;
}

// API Phân phối ByteBuffer
app.get('/libs/bytebuffer.min.js', async (req, res) => {
    if (fs.existsSync(BYTEBUFFER_PATH)) {
        return res.sendFile(BYTEBUFFER_PATH);
    }
    try {
        const response = await axios.get("https://raw.githubusercontent.com/dcodeIO/ByteBuffer.js/master/dist/bytebuffer.min.js");
        fs.writeFileSync(BYTEBUFFER_PATH, response.data, 'utf8');
        res.setHeader('Content-Type', 'application/javascript');
        res.send(response.data);
    } catch (e) { res.status(500).send("Lỗi tải ByteBuffer"); }
});

// API Callback Discord
app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send("No code");
    try {
        const params = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
        const tokenRes = await axios.post('https://discord.com/api/oauth2/token', params.toString());
        const userRes = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
        
        const userData = userRes.data;
        const db = client.db(dbName);
        const doc = await getDB();

        if (doc.blacklist[userData.id]) return res.send("<script>alert('Bị cấm!'); window.close();</script>");

        if (!doc.users[userData.id]) {
            await db.collection(COLLECTION).updateOne({ _id: "config" }, { $set: { [`users.${userData.id}`]: { username: userData.username, approved: false, time: new Date().toLocaleString() } } });
        }

        const isApproved = doc.whitelist[userData.id] || (doc.users[userData.id]?.approved);
        res.send(`
            <script>
                window.opener.postMessage({ type: 'DISCORD_LOGIN_SUCCESS', id: '${userData.id}', approved: ${!!isApproved} }, 'https://zombs.io');
                window.close();
            </script>
        `);
    } catch (e) { res.status(500).send("Lỗi xác thực."); }
});

// API Check User
app.get('/api/check-user', async (req, res) => {
    const doc = await getDB();
    const id = req.query.id;
    if (!id || doc.blacklist[id]) return res.json({ approved: false });
    const approved = !!(doc.whitelist[id] || doc.users[id]?.approved);
    const script = approved && fs.existsSync(HACK_SCRIPT_PATH) ? fs.readFileSync(HACK_SCRIPT_PATH, 'utf8') : "";
    res.json({ approved, script });
});

// API Quản lý Admin
app.post('/api/manage', async (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).send("No");
    const { action, id, name } = req.body;
    const db = client.db(dbName);
    
    if (action === 'toggle') {
        const doc = await getDB();
        await db.collection(COLLECTION).updateOne({ _id: "config" }, { $set: { [`users.${id}.approved`]: !doc.users[id]?.approved } });
    } else if (action === 'whitelist') {
        await db.collection(COLLECTION).updateOne({ _id: "config" }, { $set: { [`whitelist.${id}`]: name } });
    } else if (action === 'blacklist') {
        await db.collection(COLLECTION).updateOne({ _id: "config" }, { $set: { [`blacklist.${id}`]: name }, $unset: { [`users.${id}`]: "" } });
    }
    res.redirect('/admin?pwd=' + ADMIN_PASSWORD);
});

// Admin Panel
app.get('/admin', async (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).send("Forbidden");
    const doc = await getDB();
    res.send(`
        <html><body>
        <h1>🛡️ Xenostia Control Panel</h1>
        <table border="1">
            ${Object.entries(doc.users).map(([id, u]) => `
                <tr><td>${u.username}</td><td>${u.approved ? '✅' : '❌'}</td>
                <td><form action="/api/manage?pwd=${ADMIN_PASSWORD}" method="POST">
                    <input type="hidden" name="id" value="${id}"><input type="hidden" name="action" value="toggle">
                    <button>Duyệt/Thu hồi</button>
                </form></td></tr>`).join('')}
        </table>
        <h2>Whitelist</h2><pre>${JSON.stringify(doc.whitelist, null, 2)}</pre>
        </body></html>
    `);
});

module.exports = app;