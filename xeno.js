require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    next();
});

// Hàm lấy DB
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

// API Discord Callback
app.get('/callback', async (req, res) => {
    const { code } = req.query;
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
        res.send(`<script>window.opener.postMessage({ type: 'DISCORD_LOGIN_SUCCESS', id: '${userData.id}', approved: ${!!isApproved} }, 'https://zombs.io'); window.close();</script>`);
    } catch (e) { res.status(500).send("Lỗi xác thực."); }
});

// API Check User
app.get('/api/check-user', async (req, res) => {
    const doc = await getDB();
    const id = req.query.id;
    if (!id || doc.blacklist[id]) return res.json({ approved: false });
    
    const approved = !!(doc.whitelist[id] || doc.users[id]?.approved);
    res.json({ approved, script: approved && fs.existsSync(HACK_SCRIPT_PATH) ? fs.readFileSync(HACK_SCRIPT_PATH, 'utf8') : "" });
});

// API Admin Control Panel
app.get('/admin', async (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).send("Forbidden");
    const doc = await getDB();
    
    // Giao diện quản lý
    res.send(`
        <h1>🛡️ XENOSTIA ADMIN</h1>
        <table border="1">
            ${Object.entries(doc.users).map(([id, u]) => `
                <tr>
                    <td>${u.username}</td>
                    <td>${u.approved ? '✅' : '❌'}</td>
                    <td><form action="/api/admin/action?pwd=${ADMIN_PASSWORD}" method="POST">
                        <input type="hidden" name="id" value="${id}">
                        <input type="hidden" name="action" value="toggle">
                        <button>Duyệt/Thu hồi</button>
                    </form></td>
                </tr>`).join('')}
        </table>
    `);
});

app.post('/api/admin/action', async (req, res) => {
    if (req.query.pwd !== ADMIN_PASSWORD) return res.status(403).send("No");
    const { id, action } = req.body;
    const db = client.db(dbName);
    const doc = await getDB();
    
    if (action === 'toggle') {
        await db.collection(COLLECTION).updateOne({ _id: "config" }, { $set: { [`users.${id}.approved`]: !doc.users[id]?.approved } });
    }
    res.redirect('/admin?pwd=' + ADMIN_PASSWORD);
});

module.exports = app;