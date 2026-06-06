require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const app = express();

// --- 1. KẾT NỐI MONGODB CHUẨN SERVERLESS ---
const MONGODB_URI = process.env.MONGODB_URI;
let isConnected = false;

async function connectDB() {
    if (isConnected) return;
    try {
        await mongoose.connect(MONGODB_URI);
        isConnected = true;
        console.log("MongoDB Connected");
    } catch (err) {
        console.error("DB Connection Error:", err);
        throw err;
    }
}

// Model Schema
const DataSchema = new mongoose.Schema({ _id: String, users: Object, whitelist: Object, blacklist: Object });
const DataModel = mongoose.model('AppData', DataSchema);

async function getDB() {
    await connectDB();
    let doc = await DataModel.findById('main_config');
    if (!doc) {
        doc = new DataModel({ _id: 'main_config', users: {}, whitelist: {}, blacklist: {} });
        await doc.save();
    }
    return doc;
}

// --- 2. MIDDLEWARE ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

const { DISCORD_CLIENT_SECRET: SECRET, ADMIN_PASSWORD: PWD, DISCORD_CLIENT_ID: ID, REDIRECT_URI } = process.env;

// --- 3. LOGIC XỬ LÝ ---
app.get('/callback', async (req, res) => {
    try {
        const { code } = req.query;
        const params = new URLSearchParams({ client_id: ID, client_secret: SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
        const tokenRes = await axios.post('https://discord.com/api/oauth2/token', params.toString());
        const userRes = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
        
        const doc = await getDB();
        if (doc.blacklist[userRes.data.id]) return res.send("<script>alert('Bị cấm!'); window.close();</script>");

        if (!doc.users[userRes.data.id]) {
            doc.users[userRes.data.id] = { username: userRes.data.username, approved: false, time: new Date().toLocaleString() };
            doc.markModified('users');
            await doc.save();
        }
        res.send(`<h3>Xác thực thành công!</h3><script>window.opener.postMessage({type:'DISCORD_LOGIN_SUCCESS', id:'${userRes.data.id}'}, 'https://zombs.io'); window.close();</script>`);
    } catch (e) { res.status(500).send("Lỗi: " + e.message); }
});

app.get('/api/check-user', async (req, res) => {
    const { id } = req.query;
    const doc = await getDB();
    if (doc.blacklist[id]) return res.json({ approved: false });
    
    if (doc.whitelist[id] && !doc.users[id]?.approved) {
        if (!doc.users[id]) doc.users[id] = { username: "User", time: new Date().toLocaleString() };
        doc.users[id].approved = true;
        doc.markModified('users');
        await doc.save();
    }
    
    res.json({ approved: !!doc.users[id]?.approved, script: doc.users[id]?.approved ? "/* Content */" : "" });
});

app.get('/admin', async (req, res) => {
    if (req.query.pwd !== PWD) return res.status(403).send("Forbidden");
    const doc = await getDB();
    // Render dashboard tại đây
    res.send(`<h1>Admin Panel</h1><pre>${JSON.stringify(doc.users, null, 2)}</pre>`);
});

app.post('/api/toggle-approve', async (req, res) => {
    if (req.query.pwd !== PWD) return res.status(403).end();
    const doc = await getDB();
    if (doc.users[req.body.id]) {
        doc.users[req.body.id].approved = !doc.users[req.body.id].approved;
        doc.markModified('users');
        await doc.save();
    }
    res.json({ success: true });
});

module.exports = app;