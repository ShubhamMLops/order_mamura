const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('baileys');
const QRCode = require('qrcode');
const pino   = require('pino');

// Force stdout flush so QR appears immediately in GitHub Actions logs
if (process.stdout._handle) process.stdout._handle.setBlocking(true);
const fs     = require('fs');
const path   = require('path');

const FIREBASE_URL  = process.env.FIREBASE_URL;
const ADMIN_EMAIL   = process.env.ADMIN_EMAIL;
const SMTP_USER     = process.env.SMTP_USER;
const SMTP_PASS     = process.env.SMTP_PASS;
const SMTP_HOST     = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT     = parseInt(process.env.SMTP_PORT || '465');
const STORE_NAME    = process.env.STORE_NAME || 'Mamura';
const DELIVERY_FEE  = 50;
const GST_RATE      = 0.05;
const FREE_DELIVERY = 375;
const SESSION_DIR   = 'session_data';

const sessions = {};

// ── Session persistence (cart survives bot restarts) ──────────────────────────
async function saveSessions() {
    if (!FIREBASE_URL) return;
    try {
        // Only save sessions that have a cart with items
        const toSave = {};
        for (const [k, v] of Object.entries(sessions)) {
            if (v.cart?.length) toSave[k.replace(/[.#$[\]]/g, '_')] = JSON.stringify(v);
        }
        await fetch(`${FIREBASE_URL}/wa_sessions.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(toSave)
        });
    } catch(e) {}
}

async function loadSessions() {
    if (!FIREBASE_URL) return;
    try {
        const res  = await fetch(`${FIREBASE_URL}/wa_sessions.json`);
        const data = await res.json();
        if (!data || typeof data !== 'object') return;
        for (const [k, v] of Object.entries(data)) {
            try {
                const key = k.replace(/_/g, '.');  // rough reverse — good enough
                sessions[key] = JSON.parse(v);
            } catch(e) {}
        }
        const count = Object.keys(sessions).length;
        if (count) console.log(`[Sessions] Restored ${count} active cart(s)`);
    } catch(e) {}
}

// ── Firebase session persistence ──────────────────────────────────────────────

async function saveSessionToFirebase() {
    if (!FIREBASE_URL) return;
    try {
        if (!fs.existsSync(SESSION_DIR)) return;
        const payload = {};
        for (const file of fs.readdirSync(SESSION_DIR)) {
            const fullPath = path.join(SESSION_DIR, file);
            if (fs.statSync(fullPath).isFile())
                payload[file.replace(/\./g, '__DOT__')] = fs.readFileSync(fullPath, 'utf8');
        }
        await fetch(`${FIREBASE_URL}/wa_session.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        console.log('[Session] Saved ✓');
    } catch (e) { console.error('[Session] Save error:', e.message); }
}

async function restoreSessionFromFirebase() {
    if (!FIREBASE_URL) return;
    try {
        const res  = await fetch(`${FIREBASE_URL}/wa_session.json`);
        const data = await res.json();
        if (!data || typeof data !== 'object') { console.log('[Session] Fresh start.'); return; }
        if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
        for (const [key, value] of Object.entries(data))
            fs.writeFileSync(path.join(SESSION_DIR, key.replace(/__DOT__/g, '.')), value, 'utf8');
        console.log('[Session] Restored ✓');
    } catch (e) { console.error('[Session] Restore error:', e.message); }
}

// ── Firebase menu ─────────────────────────────────────────────────────────────

async function getMenu() {
    try {
        const res  = await fetch(`${FIREBASE_URL}/dishes.json`);
        const data = await res.json();
        if (!data) return [];
        return Object.keys(data)
            .map(k => ({ id: k, ...data[k], portions: data[k].portions || null }))
            .filter(d => !d.outOfStock);
    } catch (e) { console.error('[Menu] Fetch error:', e); return []; }
}

async function getMenuImageUrl() {
    try {
        const res  = await fetch(`${FIREBASE_URL}/settings/menuImageUrl.json`);
        const url  = await res.json();
        return (url && typeof url === 'string' && url.startsWith('http')) ? url : null;
    } catch { return null; }
}

// ── Menu text — numbered list ─────────────────────────────────────────────────

// Returns { text, indexMap } where indexMap[n] = dish
function buildMenuText(menu) {
    const grouped = {};
    menu.forEach(d => {
        const cat = (d.category || 'Other').charAt(0).toUpperCase() + (d.category || 'other').slice(1);
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(d);
    });

    let txt = '*🍽️ ScwOrder — Menu*\n' + '─'.repeat(28) + '\n\n';
    let n = 1;
    const indexMap = {};

    Object.entries(grouped).forEach(([cat, items]) => {
        txt += `*${cat.toUpperCase()}*\n`;
        items.forEach(d => {
            indexMap[n] = d;
            if (d.portions?.length) {
                const sizes = d.portions.map(p => `${p.name[0]} ₹${p.price}`).join(' | ');
                txt += `  *${n}.* ${d.name} — ${sizes}\n`;
            } else {
                txt += `  *${n}.* ${d.name} — ₹${d.price || '—'}\n`;
            }
            n++;
        });
        txt += '\n';
    });

    txt += '─'.repeat(28) + '\n';
    txt += '📝 *How to order:*\n';
    txt += 'Type the item number(s) to order!\n';
    txt += '_Example: 3_ (single item)\n';
    txt += '_Example: 3 s_ (item 3, small size)\n';
    txt += '_Example: 3,7,12_ (multiple items)\n\n';
    txt += '📌 *Commands:*\n';
    txt += '*cart* — view cart | *done* — checkout\n';
    txt += '*add* — add more | *empty* — clear | *cancel* — cancel\n\n';
    txt += '_5% GST applicable. Free delivery above ₹375._';

    return { text: txt, indexMap };
}

// ── Fuzzy matcher ─────────────────────────────────────────────────────────────

function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            dp[i][j] = a[i-1] === b[j-1]
                ? dp[i-1][j-1]
                : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[a.length][b.length];
}

// Returns 0–1 score: how well queryTokens match nameTokens (case-insensitive)
function matchScore(queryTokens, nameTokens) {
    let matched = 0;
    for (const nt of nameTokens) {
        // Exact match
        if (queryTokens.includes(nt)) { matched++; continue; }
        // Substring match (e.g. "choc" matches "chocolate")
        if (queryTokens.some(qt => nt.startsWith(qt) && qt.length >= 3)) { matched += 0.8; continue; }
        // Fuzzy match for longer words (typo tolerance)
        if (nt.length >= 4) {
            const minDist = Math.min(...queryTokens.map(qt => levenshtein(qt, nt)));
            if (minDist <= 1) { matched += 0.9; continue; }
            if (minDist <= 2) { matched += 0.5; continue; }
        }
    }
    return matched / nameTokens.length; // 0.0 to 1.0
}

const SIZE_MAP = {
    's': 'Small', 'sm': 'Small', 'small': 'Small',
    'm': 'Medium', 'med': 'Medium', 'medium': 'Medium',
    'l': 'Large',  'lg': 'Large',  'large':  'Large',
    'half': 'Half', 'full': 'Full',
    '250ml': '250ml', '500ml': '500ml', '1l': '1L', '1ltr': '1L'
};

const SIZE_WORDS = new Set(Object.keys(SIZE_MAP));

// Common words that alone shouldn't trigger a match
const STOP_WORDS = new Set(['veg', 'non', 'special', 'double', 'steam', 'fried', 'crispy', 'spicy', 'hot', 'cold', 'fresh', 'plain']);

function findBestMatch(query, menu) {
    const allTokens    = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    const sizeTokens   = allTokens.filter(t => SIZE_WORDS.has(t));
    const foodTokens   = allTokens.filter(t => !SIZE_WORDS.has(t));
    const searchTokens = foodTokens.length ? foodTokens : allTokens;

    const scored = menu.map(item => {
        const nameTokens = item.name.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
        const rawScore   = matchScore(searchTokens, nameTokens);

        // Keyword boost: if any query token (4+ chars, not a stop word) exactly matches
        // a name token, guarantee at least 0.5 score so "momos" finds "Steam Veg Momos"
        const hasKeyword = searchTokens.some(qt =>
            qt.length >= 4 && !STOP_WORDS.has(qt) && nameTokens.includes(qt)
        );

        return { item, score: hasKeyword ? Math.max(rawScore, 0.5) : rawScore };
    })
    .filter(x => x.score >= 0.35)
    .sort((a, b) => b.score - a.score);

    if (!scored.length) return null;

    // Show numbered list if multiple items match similarly
    if (scored.length >= 2) {
        const name0 = scored[0].item.name.toLowerCase();
        const name1 = scored[1].item.name.toLowerCase();
        const scoresClose = (scored[0].score - scored[1].score) < 0.15;
        const manyMatches = scored.length >= 3 && scored[2].score >= 0.35;
        if ((scoresClose || manyMatches) && !name0.includes(name1) && !name1.includes(name0)) {
            return { ambiguous: true, candidates: scored.slice(0, Math.min(5, scored.length)).map(x => x.item) };
        }
    }

    const bestItem = scored[0].item;
    let foundPortion = null;
    if (bestItem.portions?.length) {
        for (const t of sizeTokens) {
            const sizeName = SIZE_MAP[t];
            if (sizeName) {
                foundPortion = bestItem.portions.find(p => p.name.toLowerCase() === sizeName.toLowerCase());
                if (foundPortion) break;
            }
        }
        if (!foundPortion) {
            for (const t of allTokens) {
                foundPortion = bestItem.portions.find(p => p.name.toLowerCase() === t);
                if (foundPortion) break;
            }
        }
    }

    return { item: bestItem, portion: foundPortion, needsPortion: !!(bestItem.portions?.length && !foundPortion) };
}

// ── Quantity parser ("2 burgers", "double momos", "3x pizza") ─────────────────

const WORD_NUMS = { one:1, two:2, three:3, four:4, five:5, double:2, triple:3 };

function parseQuantityAndQuery(part) {
    const numMatch = part.match(/^(\d+)[x\s]+(.+)/i);
    if (numMatch) return { qty: parseInt(numMatch[1]), query: numMatch[2].trim() };
    for (const [word, num] of Object.entries(WORD_NUMS)) {
        const m = part.match(new RegExp(`^${word}\\s+(.+)`, 'i'));
        if (m) return { qty: num, query: m[1].trim() };
    }
    return { qty: 1, query: part.trim() };
}

function parseOrder(input, menu) {
    const parts    = input.split(/\s*\+\s*|\s+and\s+/i).map(p => p.trim()).filter(Boolean);
    const resolved = [], unresolved = [], ambiguous = [];
    for (const part of parts) {
        const { qty, query } = parseQuantityAndQuery(part);
        const match = findBestMatch(query, menu);
        if (!match) {
            unresolved.push(part);
        } else if (match.ambiguous) {
            ambiguous.push({ query: part, candidates: match.candidates });
        } else {
            for (let i = 0; i < qty; i++) resolved.push({ ...match });
        }
    }
    return { resolved, unresolved, ambiguous };
}

// ── "Did you mean?" suggestions ───────────────────────────────────────────────

function getSuggestions(input, menu, limit = 3) {
    const tokens = input.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    return menu
        .map(item => {
            const nameTokens = item.name.toLowerCase().split(/\s+/);
            const score = matchScore(tokens, nameTokens);
            return { item, score };
        })
        .filter(x => x.score > 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(x => x.item.name);
}

// ── Bill helpers ──────────────────────────────────────────────────────────────

function calcBill(cart) {
    const subtotal = cart.reduce((s, e) =>
        s + (e.portion ? parseFloat(e.portion.price) : parseFloat(e.item.price || 0)), 0);
    const gst      = Math.round(subtotal * GST_RATE);
    const delivery = subtotal >= FREE_DELIVERY ? 0 : DELIVERY_FEE;
    return { subtotal, gst, delivery, total: subtotal + gst + delivery };
}

function cartLines(cart) {
    const grouped = [];
    for (const e of cart) {
        const label = e.portion ? `${e.item.name} (${e.portion.name})` : e.item.name;
        const price = e.portion ? parseFloat(e.portion.price) : parseFloat(e.item.price || 0);
        const last  = grouped[grouped.length - 1];
        if (last && last.label === label) { last.qty++; last.price += price; }
        else grouped.push({ label, qty: 1, price });
    }
    return grouped.map((g, i) =>
        `${i + 1}. ${g.label}${g.qty > 1 ? ` ×${g.qty}` : ''} — ₹${g.price}`
    ).join('\n');
}

function billBlock(cart) {
    const { subtotal } = calcBill(cart);
    return `\n\n💰 *Bill:*\n` +
        `Subtotal : ₹${subtotal}\n\n` +
        `_Note: 5% GST applicable. Delivery charges will apply if order value is below ₹375 or delivery location is beyond 3 km._`;
}

// ── Store timing check ────────────────────────────────────────────────────────
async function isStoreOpen() {
    try {
        const res  = await fetch(`${FIREBASE_URL}/settings.json`);
        const data = await res.json();
        if (!data) return true;

        // Force close overrides timings
        if (data.forceClose === true) return false;

        // If no timings set, default open
        if (!data.openTime || !data.closeTime) return true;

        // Use IST (UTC+5:30) — admin sets timings in Indian time
        const nowIST   = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const nowMin   = nowIST.getHours() * 60 + nowIST.getMinutes();

        const [oh, om] = data.openTime.split(':').map(Number);
        const [ch, cm] = data.closeTime.split(':').map(Number);
        const openMin  = oh * 60 + om;
        const closeMin = ch * 60 + cm;

        if (closeMin > openMin) {
            // Normal window e.g. 09:00 – 22:00
            return nowMin >= openMin && nowMin < closeMin;
        } else {
            // Overnight window e.g. 22:00 – 02:00
            return nowMin >= openMin || nowMin < closeMin;
        }
    } catch(e) { return true; }
}

async function getStoreClosedMessage() {
    try {
        const res  = await fetch(`${FIREBASE_URL}/settings.json`);
        const data = await res.json();
        const openTime  = data?.openTime  || '09:00';
        const closeTime = data?.closeTime || '22:00';

        function fmt(t) {
            const [h, m] = t.split(':').map(Number);
            const ampm = h >= 12 ? 'PM' : 'AM';
            const h12  = h % 12 || 12;
            return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
        }

        // Custom reason only shown when admin force-closed the store
        const reason = (data?.forceClose === true && data?.closeReason?.trim())
            ? data.closeReason.trim()
            : null;
        const reasonLine = reason ? `\n\n_${reason}_` : '';

        return `🔒 *Our outlet is currently closed.*${reasonLine}\n\nWe are open from *${fmt(openTime)}* to *${fmt(closeTime)}* (IST).\n\nKindly place your order during our working hours. Thank you! 🙏`;
    } catch(e) {
        return `🔒 *Our outlet is currently closed.* Please check back later!`;
    }
}

// ── Send order email notification ─────────────────────────────────────────────
async function sendOrderEmail(order, cartItems) {
    if (!ADMIN_EMAIL || !SMTP_USER || !SMTP_PASS) return;
    try {
        const itemLines = cartItems.map(e => {
            const name  = e.portion ? `${e.item.name} (${e.portion.name})` : e.item.name;
            const price = e.portion ? e.portion.price : (e.item.price || 0);
            return `  • ${name} — Rs.${price}`;
        }).join('\n');
        const subtotal = cartItems.reduce((s, e) =>
            s + parseFloat(e.portion ? e.portion.price : (e.item.price || 0)), 0);
        const subject = `[${STORE_NAME}] New Order — Rs.${subtotal.toFixed(0)} — ${order.phone}`;
        const body =
            `${STORE_NAME} — New WhatsApp Order Received!\n` +
            `${'='.repeat(40)}\n\n` +
            `Time    : ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n` +
            `Phone   : ${order.phone}\n` +
            `Address : ${order.address}\n\n` +
            `Items:\n${itemLines}\n\n` +
            `Subtotal: Rs.${subtotal.toFixed(0)}\n` +
            `Note    : +5% GST applicable\n\n` +
            `Open admin panel to accept the order.`;
        await smtpSend(ADMIN_EMAIL, subject, body);
    } catch(e) { /* silent */ }
}

function smtpSend(to, subject, body) {
    return new Promise((resolve, reject) => {
        const tls = require('tls');
        const socket = tls.connect(SMTP_PORT, SMTP_HOST, { rejectUnauthorized: false }, () => {
            let buf = '';
            const read = (cb) => {
                const handler = (d) => {
                    buf += d.toString();
                    if (buf.includes('\r\n')) { const line = buf; buf = ''; socket.removeListener('data', handler); cb(line); }
                    else socket.once('data', handler);
                };
                socket.once('data', handler);
            };
            const cmd = (c) => socket.write(c + '\r\n');
            read(() => {
                cmd(`EHLO ${SMTP_HOST}`);
                read(() => {
                    cmd(`AUTH LOGIN`);
                    read(() => {
                        cmd(Buffer.from(SMTP_USER).toString('base64'));
                        read(() => {
                            cmd(Buffer.from(SMTP_PASS).toString('base64'));
                            read((res) => {
                                if (!res.includes('235')) { socket.destroy(); return reject(new Error('Auth failed')); }
                                cmd(`MAIL FROM: <${SMTP_USER}>`);
                                read(() => {
                                    cmd(`RCPT TO: <${to}>`);
                                    read(() => {
                                        cmd('DATA');
                                        read(() => {
                                            socket.write(
                                                `From: ${STORE_NAME} <${SMTP_USER}>\r\nTo: <${to}>\r\nSubject: ${subject}\r\n` +
                                                `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}\r\n.\r\n`
                                            );
                                            read(() => { cmd('QUIT'); socket.destroy(); resolve(); });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
        socket.on('error', reject);
    });
}

async function startBot() {
    if (!FIREBASE_URL) { console.error('ERROR: FIREBASE_URL missing!'); process.exit(1); }

    await restoreSessionFromFirebase();
    await loadSessions();

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version, auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['ScwOrder', 'Chrome', '1.0'],
        // Suppress Bad MAC noise — these are harmless decryption errors from old messages
        getMessage: async () => ({ conversation: '' })
    });

    let saveDebounce = null;
    let connectedAt  = null;

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            const b64 = (await QRCode.toDataURL(qr, { errorCorrectionLevel: 'H', scale: 8, margin: 2 }))
                .replace('data:image/png;base64,', '');
            process.stdout.write('\n════════════════════════════════════\n');
            process.stdout.write('QR CODE — copy lines between START/END\n');
            process.stdout.write('Remove newlines, paste at:\n');
            process.stdout.write('https://base64.guru/converter/decode/image\n');
            process.stdout.write('════════════════════════════════════\n');
            process.stdout.write('BASE64_START\n');
            (b64.match(/.{1,76}/g) || []).forEach(l => process.stdout.write(l + '\n'));
            process.stdout.write('BASE64_END\n');
            process.stdout.write('════════════════════════════════════\n\n');
        }
        if (connection === 'open') {
            console.log('✅ ScwOrder Bot ONLINE');
            connectedAt = Date.now();
        }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === DisconnectReason.loggedOut || code === 401 || code === 403 || code === 440) {
                console.log(`[Session] Clearing session (code ${code}) — will show fresh QR...`);
                try { await fetch(`${FIREBASE_URL}/wa_session.json`, { method: 'DELETE' }); } catch(e) {}
                try {
                    if (fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                } catch(e) {}
            } else {
                console.log(`[Connection] Closed (code ${code}) — reconnecting in 5s...`);
            }
            setTimeout(startBot, 5000);
        }
    });

    sock.ev.on('creds.update', async () => {
        saveCreds();
        clearTimeout(saveDebounce);
        saveDebounce = setTimeout(async () => {
            if (connectedAt && Date.now() - connectedAt > 10000) {
                await saveSessionToFirebase();
            }
        }, 5000);
    });

    // ── Order status poller ───────────────────────────────────────────────────
    const sentMsgs = new Set();
    setInterval(async () => {
        try {
            const orders = await (await fetch(`${FIREBASE_URL}/orders.json`)).json();
            if (!orders) return;
            for (const [key, order] of Object.entries(orders)) {
                if (Date.now() - new Date(order.timestamp || 0).getTime() > 86400000) continue;
                const digits = (order.waNumber || order.phone || '').replace(/\D/g, '');
                if (!digits || digits.length < 10) continue;
                const jid = (digits.startsWith('91') ? digits : '91' + digits) + '@s.whatsapp.net';

                if (order.accepted === true && !order.acceptedMsgSent && !sentMsgs.has(key + '_acc')) {
                    sentMsgs.add(key + '_acc');
                    await sock.sendMessage(jid, {
                        text: '✅ *Order Accepted!*\n\nYour food is being prepared 👨‍🍳\nWe\'ll share payment details shortly. Thank you! 🙏'
                    }).catch(() => {});
                    await fetch(`${FIREBASE_URL}/orders/${key}.json`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ acceptedMsgSent: true })
                    });
                }
                if (order.accepted === false && !order.rejectedMsgSent && !sentMsgs.has(key + '_rej')) {
                    sentMsgs.add(key + '_rej');
                    await sock.sendMessage(jid, {
                        text: '❌ *Sorry, we couldn\'t accept your order right now.*\n\nPlease try again later or type *menu* to reorder.'
                    }).catch(() => {});
                    await fetch(`${FIREBASE_URL}/orders/${key}.json`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ rejectedMsgSent: true })
                    });
                }
            }
        } catch (e) { console.log('[Poll] Error:', e.message); }
    }, 5000);

    let sessionSaveTimer = null;
    function debounceSaveSessions() {
        clearTimeout(sessionSaveTimer);
        sessionSaveTimer = setTimeout(saveSessions, 2000);
    }

    // ── Cart expiry — clear inactive carts every minute ──────────────────────
    const CART_TIMEOUT_MS = 5 * 60 * 1000; // 10 minutes
    setInterval(async () => {
        const now = Date.now();
        for (const [sender, session] of Object.entries(sessions)) {
            if (!session.cart?.length) continue;
            const last = session.lastActivity || 0;
            if (now - last > CART_TIMEOUT_MS) {
                delete sessions[sender];
                try {
                    await sock.sendMessage(sender, {
                        text: '🛒 Your cart has been cleared due to 05 minutes of inactivity.\n\nType *menu* to start a new order!'
                    });
                } catch(e) {}
            }
        }
    }, 60 * 1000);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.fromMe) return;

        const sender  = msg.key.remoteJid;
        const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        if (!rawText) return;

        const text    = rawText.toLowerCase().trim();
        const session = sessions[sender] || {};
        const send    = t => {
            // Update last activity timestamp on every interaction
            if (sessions[sender]) sessions[sender].lastActivity = Date.now();
            debounceSaveSessions();
            return sock.sendMessage(sender, { text: t });
        };

        // Log only message length — never log phone numbers or message content
        console.log(`[Msg] ${text.length} chars`);

        // ── Store timing check — block ALL messages if closed ─────────────────
        // Only allow: cancel (to clear stuck sessions)
        if (text !== 'cancel' && !(await isStoreOpen())) {
            return send(await getStoreClosedMessage());
        }

        // ── Global commands (always work regardless of state) ─────────────────
        if (text === 'cancel') {
            delete sessions[sender];
            return send('❌ Order cancelled.\n\nType *menu* to start fresh or just tell me what you want!');
        }
        if (text === 'empty' || text === 'clear') {
            delete sessions[sender];
            return send('🗑️ Cart cleared!\n\nWhat would you like to order? Type *menu* to browse.');
        }
        if (/^(menu|price|prices|list|items)$/.test(text)) {
            const menu = await getMenu();
            const { text: menuText, indexMap } = buildMenuText(menu);
            sessions[sender] = { ...(sessions[sender] || {}), indexMap };
            // Send menu image first if admin has uploaded one
            const menuImgUrl = await getMenuImageUrl();
            if (menuImgUrl) {
                await sock.sendMessage(sender, {
                    image: { url: menuImgUrl },
                    caption: '🍽️ *ScwOrder Menu*\n\nSee full menu with prices below 👇'
                });
            }
            return send(menuText);
        }
        if (/^(cart|my cart|bag|view cart|show cart|mycart)$/.test(text)) {
            if (!session.cart?.length)
                return send('🛒 Your cart is empty.\n\nType *menu* or just tell me what you want!');
            return send(
                `🛒 *Your Cart:*\n${cartLines(session.cart)}${billBlock(session.cart)}\n\n` +
                `*Options:*\n` +
                `• Type *proceed* or *done* → checkout\n` +
                `• Type *add* → add more items\n` +
                `• Type *empty* → clear cart\n` +
                `• Type *cancel* → cancel order`
            );
        }
        if (/^(proceed|done|checkout|place order|confirm|order now)$/.test(text)) {
            if (!session.cart?.length)
                return send('🛒 Your cart is empty!\n\nTell me what you want to order or type *menu* to browse.');
            sessions[sender] = { ...session, step: 'AWAITING_DETAILS' };
            return send(
                `🛒 *Order Summary:*\n${cartLines(session.cart)}${billBlock(session.cart)}\n\n` +
                `Please share your *Name, Phone & Address* to confirm.\n` +
                `_Example: Ravi, 9876543210, 12 MG Road, Delhi_\n\n` +
                `_Type *add* to add more items first_`
            );
        }
        if (/^(add|add more|more)$/.test(text)) {
            if (session.cart?.length) {
                const menu = await getMenu();
                const { text: menuText, indexMap } = buildMenuText(menu);
                sessions[sender] = { ...session, step: 'ADDING', indexMap };
                return send(`➕ *Current cart:*\n${cartLines(session.cart)}\n\n${menuText}`);
            }
            return send('Tell me what you want to order!\n\nType *menu* to see the numbered list.');
        }

        // ── AWAITING_PORTION — size selection (must be before number ordering) ──
        if (session.step === 'AWAITING_PORTION') {
            const { pendingItem, cart, pendingItems } = session;
            const portions = pendingItem.portions;
            const choice   = parseInt(text);
            let portion    = null;

            if (!isNaN(choice) && choice >= 1 && choice <= portions.length) {
                portion = portions[choice - 1];
            } else {
                portion = portions.find(p =>
                    p.name.toLowerCase() === text ||
                    SIZE_MAP[text]?.toLowerCase() === p.name.toLowerCase()
                );
            }

            if (!portion) {
                const opts = portions.map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
                return send(
                    `Please choose a size for *${pendingItem.name}*:\n\n${opts}\n\n` +
                    `_Reply with a number (1, 2, 3) or size name (s/m/l)_`
                );
            }

            cart.push({ item: pendingItem, portion });
            const next = pendingItems?.shift();
            if (next) {
                sessions[sender] = { step: 'AWAITING_PORTION', pendingItem: next, pendingItems, cart };
                const opts = next.portions.map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
                return send(`✅ *${portion.name} ${pendingItem.name}* added!\n\nNow, which size for *${next.name}*?\n\n${opts}`);
            }

            sessions[sender] = { step: 'AWAITING_DETAILS', cart };
            return send(
                `✅ *${portion.name} ${pendingItem.name}* added!\n\n` +
                `*Your Order:*\n${cartLines(cart)}${billBlock(cart)}\n\n` +
                `Please share your *Name, Phone & Address* to confirm.\n` +
                `_Example: Ravi, 9876543210, 12 MG Road, Delhi_\n\n` +
                `_Type *add* to add more | *cart* to review | *cancel* to cancel_`
            );
        }

        // ── AWAITING_CLARIFICATION — must be before number ordering too ───────
        if (session.step === 'AWAITING_CLARIFICATION') {
            const { ambiguousCandidates, pendingAmbiguous, pendingResolved } = session;
            const choice = parseInt(text);
            if (isNaN(choice) || choice < 1 || choice > ambiguousCandidates.length) {
                const opts = ambiguousCandidates.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
                return send(`Please reply with a number 1–${ambiguousCandidates.length}:\n\n${opts}`);
            }
            const chosenItem = ambiguousCandidates[choice - 1];
            const newResolved = [...pendingResolved, {
                item: chosenItem, portion: null, needsPortion: !!(chosenItem.portions?.length)
            }];
            if (pendingAmbiguous?.length) {
                const next = pendingAmbiguous[0];
                sessions[sender] = { ...session, step: 'AWAITING_CLARIFICATION', ambiguousQuery: next.query, ambiguousCandidates: next.candidates, pendingAmbiguous: pendingAmbiguous.slice(1), pendingResolved: newResolved };
                const opts = next.candidates.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
                return send(`✅ Got it!\n\nNow, which one for "*${next.query}*"?\n\n${opts}`);
            }
            const existingCart = (sessions[sender] || {}).cart || [];
            const needsPortion = newResolved.filter(e => e.needsPortion);
            const readyItems   = newResolved.filter(e => !e.needsPortion).map(e => ({ item: e.item, portion: e.portion }));
            const cart         = [...existingCart, ...readyItems];
            if (needsPortion.length) {
                const first = needsPortion.shift();
                sessions[sender] = { step: 'AWAITING_PORTION', pendingItem: first.item, pendingItems: needsPortion.map(e => e.item), cart };
                const opts = first.item.portions.map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
                return send(`Which size for *${first.item.name}*?\n\n${opts}`);
            }
            sessions[sender] = { step: 'AWAITING_DETAILS', cart };
            return send(
                `🛒 *Order Summary:*\n${cartLines(cart)}${billBlock(cart)}\n\n` +
                `Please share your *Name, Phone & Address*\n` +
                `_Example: Ravi, 9876543210, 12 MG Road, Delhi_\n\n` +
                `_Type *add* to add more | *cancel* to cancel_`
            );
        }

        // ── NUMBER-BASED ORDERING ─────────────────────────────────────────────        // Handles: "3", "3 s", "3,7,12", "3 small + 7" etc.
        // Works any time user has an indexMap (after viewing menu)
        const indexMap = (sessions[sender] || {}).indexMap;
        if (indexMap) {
            // Parse number entries: "3 s", "7 m", "12", "3,7,12"
            // Split on comma or + 
            const parts = text.split(/[,+]/).map(p => p.trim()).filter(Boolean);
            const resolved = [], unresolved = [];

            for (const part of parts) {
                const tokens = part.split(/\s+/);
                const num    = parseInt(tokens[0]);
                if (!isNaN(num) && indexMap[num]) {
                    const item = indexMap[num];
                    // Check for size in remaining tokens
                    let portion = null;
                    if (item.portions?.length) {
                        const sizeToken = tokens.slice(1).find(t => SIZE_MAP[t] || item.portions.find(p => p.name.toLowerCase() === t));
                        if (sizeToken) {
                            const sizeName = SIZE_MAP[sizeToken] || sizeToken;
                            portion = item.portions.find(p => p.name.toLowerCase() === sizeName.toLowerCase());
                        }
                    }
                    resolved.push({ item, portion, needsPortion: !!(item.portions?.length && !portion) });
                } else if (tokens[0] && !isNaN(parseInt(tokens[0]))) {
                    unresolved.push(part); // number out of range
                } else {
                    // Not a number — skip (will fall through to text matching below)
                    unresolved.push(null);
                }
            }

            // Only process if at least one valid number was found
            const validResolved = resolved.filter(Boolean);
            const invalidParts  = unresolved.filter(Boolean);

            if (validResolved.length) {
                const existingCart = (sessions[sender] || {}).cart || [];
                const needsPortion = validResolved.filter(e => e.needsPortion);
                const readyItems   = validResolved.filter(e => !e.needsPortion).map(e => ({ item: e.item, portion: e.portion }));
                const cart         = [...existingCart, ...readyItems];
                const warnMsg      = invalidParts.length ? `\n\n⚠️ _Invalid numbers:_ ${invalidParts.join(', ')}` : '';

                if (needsPortion.length) {
                    const first = needsPortion.shift();
                    sessions[sender] = { ...sessions[sender], step: 'AWAITING_PORTION', pendingItem: first.item, pendingItems: needsPortion.map(e => e.item), cart };
                    const opts = first.item.portions.map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
                    return send(`Which size for *${first.item.name}*?\n\n${opts}\n\n_Reply with number or: s=Small, m=Medium, l=Large_${warnMsg}`);
                }

                sessions[sender] = { ...sessions[sender], step: 'AWAITING_DETAILS', cart };
                const { subtotal } = calcBill(cart);
                return send(
                    `🛒 *Your Cart:*\n${cartLines(cart)}` +
                    `${billBlock(cart)}\n\n` +
                    `Type more numbers to add items, or:\n` +
                    `*done* — checkout | *cart* — review | *cancel* — cancel${warnMsg}`
                );
            }
        }

        // ── AWAITING_DETAILS — collect name/phone/address ─────────────────────
        if (session.step === 'AWAITING_DETAILS') {
            // Check if user is trying to add a food item instead of giving address
            const menuForCheck = await getMenu();
            const { resolved: foodCheck } = parseOrder(text, menuForCheck);
            if (foodCheck.length) {
                // User typed food — reset step so order matching picks it up with existing cart
                sessions[sender] = { ...session, step: null };
                // Re-read updated session so order matching below uses correct cart
                Object.assign(session, sessions[sender]);
                // Fall through to order matching below (no return)
            } else {
                // Extract phone — accept +91, 91, or plain 10-digit
                const phoneMatch = rawText.replace(/\s/g, '').match(/(?:\+?91)?([6-9]\d{9})/);
                if (!phoneMatch) {
                    return send(
                        `⚠️ Please include your *10-digit mobile number*.\n\n` +
                        `_Example: Ravi, *9876543210*, 12 MG Road, Delhi_\n\n` +
                        `Or type *add* to add more items | *cart* to review | *cancel* to cancel`
                    );
                }

                const { cart } = session;
                const waNumber  = sender.split('@')[0];
                const { subtotal } = calcBill(cart);
                const orderItems = cart.map(e => ({
                    id:       e.item.id,
                    name:     e.portion ? `${e.item.name} (${e.portion.name})` : e.item.name,
                    price:    e.portion ? parseFloat(e.portion.price) : parseFloat(e.item.price || 0),
                    img:      e.item.imageUrl?.startsWith('http') ? e.item.imageUrl : '',
                    quantity: 1,
                    portion:  e.portion?.name || null
                }));

                await fetch(`${FIREBASE_URL}/orders.json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId:    'whatsapp_' + waNumber,
                        userEmail: 'whatsapp@scworder.com',
                        phone:     phoneMatch[1],
                        waNumber,
                        address:   rawText,
                        location:  { lat: 0, lng: 0 },
                        items:     orderItems,
                        subtotal:  subtotal.toFixed(2),
                        status:    'Placed',
                        method:    'WhatsApp',
                        timestamp: new Date().toISOString()
                    })
                }).catch(() => console.log('[Order] Firebase error — order may not have saved'));

                // Send email notification to admin
                sendOrderEmail({ phone: phoneMatch[1], address: rawText }, cart);

                delete sessions[sender];
                return send(
                    `✅ *Order Placed Successfully!*\n\n` +
                    `*Items:*\n${cartLines(cart)}` +
                    `${billBlock(cart)}\n\n` +
                    `📍 *Address:* ${rawText}\n\n` +
                    `_Our team will contact you shortly for payment details. Thank you! 🙏_\n\n` +
                    `_Type *menu* to place another order_`
                );
            }
        }

        // ── ADDING step — skip all keyword checks, go straight to order matching ──
        if (session.step === 'ADDING') {
            const menu = await getMenu();
            const { resolved, unresolved, ambiguous } = parseOrder(text, menu);

            if (ambiguous.length) {
                const first = ambiguous[0];
                sessions[sender] = { ...session, step: 'AWAITING_CLARIFICATION', ambiguousQuery: first.query, ambiguousCandidates: first.candidates, pendingAmbiguous: ambiguous.slice(1), pendingResolved: resolved };
                const opts = first.candidates.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
                return send(`🤔 Which one did you mean for "*${first.query}*"?\n\n${opts}\n\n_Reply with a number_`);
            }

            if (resolved.length) {
                const existingCart = (sessions[sender] || {}).cart || [];
                const needsPortion = resolved.filter(e => e.needsPortion);
                const readyItems   = resolved.filter(e => !e.needsPortion).map(e => ({ item: e.item, portion: e.portion }));
                const cart         = [...existingCart, ...readyItems];
                const warnMsg      = unresolved.length ? `\n\n⚠️ _Couldn't find:_ ${unresolved.join(', ')}` : '';

                if (needsPortion.length) {
                    const first = needsPortion.shift();
                    sessions[sender] = { step: 'AWAITING_PORTION', pendingItem: first.item, pendingItems: needsPortion.map(e => e.item), cart };
                    const opts = first.item.portions.map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
                    return send(`Which size for *${first.item.name}*?\n\n${opts}${warnMsg}`);
                }

                sessions[sender] = { step: 'AWAITING_DETAILS', cart };
                return send(
                    `🛒 *Updated Cart:*\n${cartLines(cart)}` +
                    `${billBlock(cart)}\n\n` +
                    `Please share your *Name, Phone & Address*\n` +
                    `_Example: Ravi, 9876543210, 12 MG Road, Delhi_\n\n` +
                    `_Type *add* to add more | *empty* to clear | *cancel* to cancel_${warnMsg}`
                );
            }

            // Item not found while in ADDING mode
            const suggestions = getSuggestions(text, menu, 3);
            if (suggestions.length)
                return send(`🤔 Couldn't find "*${rawText}*"\n\n*Did you mean:*\n${suggestions.map(s => `• ${s}`).join('\n')}\n\nOr type *menu* to browse.`);
            return send(`Couldn't find that item. Type *menu* to browse, or try a different name.`);
        }

        // ── Greetings ─────────────────────────────────────────────────────────
        if (/^(hi|hello|hey|hii|helo|namaste|hola|start|hy|hlo)$/i.test(text))
            return send(
                `👋 *Welcome to ScwOrder!*\n\n` +
                `🍕 Pizzas | 🍔 Burgers | 🥟 Momos | ☕ Beverages & more!\n\n` +
                `Type *menu* to see everything.\n` +
                `Or just tell me what you want:\n\n` +
                `Single item: _Item Number_\n` +
                `Multiple items: _Item Number 1 + Item Number 2_\n` +
                `Example: _1 + 23_ (1 for Cheese Pizza and 23 is for Hot Coffee)\n`
            );
        // ── Common queries ────────────────────────────────────────────────────
        if (/\b(thanks|thank you|ty|shukriya|dhanyawad|thx)\b/i.test(text))
            return send('😊 You\'re welcome! Come back anytime. 🙏');

        if (/\b(time|hours|open|close|timing|kab tak|kab se)\b/i.test(text))
            return send('🕐 We\'re open daily! Type *menu* to place your order.');

        if (/\b(contact|call|support|help|issue|problem|complaint)\b/i.test(text))
            return send('📞 For support, our team will assist you directly.\n\nFor orders — just type what you want or type *menu*!');

        if (/\b(location|where|kahan|delivery area|deliver)\b/i.test(text))
            return send('📍 We deliver to nearby areas!\n\n✅ Free delivery on orders above ₹375\n📦 ₹50 delivery fee otherwise\n\nType *menu* to order!');

        if (/\b(veg|vegetarian|no meat|pure veg)\b/i.test(text) && !/order/i.test(text)) {
            const menu = await getMenu();
            const vegItems = menu.filter(d => d.isVeg || d.category?.toLowerCase().includes('veg')).slice(0, 6);
            if (vegItems.length)
                return send(`🥦 *Veg Options:*\n${vegItems.map(d => `• ${d.name}`).join('\n')}\n\n...and more! Type *menu* for full list.`);
            return send('🥦 We have great veg options! Type *menu* to see all items.');
        }

        if (/\b(non.?veg|chicken|egg|meat|mutton)\b/i.test(text) && !/order/i.test(text)) {
            const menu = await getMenu();
            const nvItems = menu.filter(d => d.isVeg === false || d.category?.toLowerCase().includes('non')).slice(0, 6);
            if (nvItems.length)
                return send(`🍗 *Non-Veg Options:*\n${nvItems.map(d => `• ${d.name}`).join('\n')}\n\nType *menu* for full list!`);
            return send('🍗 Type *menu* to see all non-veg items!');
        }

        if (/\b(cheap|cheapest|budget|affordable|less|under|below|low price)\b/i.test(text)) {
            const menu  = await getMenu();
            const cheap = menu.filter(d => !d.portions && d.price)
                .sort((a, b) => parseFloat(a.price) - parseFloat(b.price)).slice(0, 5);
            if (cheap.length)
                return send(`💰 *Budget-Friendly Picks:*\n${cheap.map(d => `• ${d.name} — ₹${d.price}`).join('\n')}\n\nType *menu* for more!`);
            return send('💰 Items start from ₹20! Type *menu* to see all prices.');
        }

        if (/\b(best|popular|recommend|special|favourite|favorite|top|trending)\b/i.test(text))
            return send(
                '⭐ *Most Popular:*\n' +
                '• Cheese Pizza — Small ₹89\n' +
                '• Veg Burger — ₹59\n' +
                '• Steam Veg Momos — ₹79\n' +
                '• Cold Coffee — ₹109\n\n' +
                'Type *menu* for the full list or just order directly!'
            );

        if (/\b(offer|discount|coupon|deal|free|promo)\b/i.test(text))
            return send('🎁 *Current Offer:*\n✅ Free delivery on orders above ₹375!\n\nType *menu* to start ordering.');

        if (/\b(payment|pay|upi|cash|cod|online|paytm|gpay|phonepe)\b/i.test(text))
            return send('💳 *Payment Options:*\n✅ UPI (GPay, PhonePe, Paytm)\n✅ Cash on Delivery\n\nPayment details shared after order confirmation.');

        if (/\b(how long|delivery time|kitna time|wait|eta|time lagega)\b/i.test(text))
            return send('⏱️ Estimated delivery: *30–45 minutes*\n\nType *menu* to place your order!');

        // ── Rule-based order matching ─────────────────────────────────────────
        const menu = await getMenu();
        const { resolved, unresolved, ambiguous } = parseOrder(text, menu);

        // Handle ambiguous items first — ask user to clarify
        if (ambiguous.length) {
            const first = ambiguous[0];
            sessions[sender] = { ...session, step: 'AWAITING_CLARIFICATION', ambiguousQuery: first.query, ambiguousCandidates: first.candidates, pendingAmbiguous: ambiguous.slice(1), pendingResolved: resolved };
            const opts = first.candidates.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
            return send(`🤔 Did you mean which one for "*${first.query}*"?\n\n${opts}\n\n_Reply with a number_`);
        }

        if (resolved.length) {
            // Always read cart from sessions[sender] — may have been updated by AWAITING_DETAILS fallthrough
            const existingCart = (sessions[sender] || {}).cart || [];
            const needsPortion = resolved.filter(e => e.needsPortion);
            const readyItems   = resolved.filter(e => !e.needsPortion).map(e => ({ item: e.item, portion: e.portion }));
            const cart         = [...existingCart, ...readyItems];
            const warnMsg      = unresolved.length ? `\n\n⚠️ _Couldn't find:_ ${unresolved.join(', ')}` : '';

            if (needsPortion.length) {
                const first = needsPortion.shift();
                sessions[sender] = {
                    step: 'AWAITING_PORTION',
                    pendingItem: first.item,
                    pendingItems: needsPortion.map(e => e.item),
                    cart
                };
                const opts = first.item.portions.map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
                return send(`Which size for *${first.item.name}*?\n\n${opts}${warnMsg}`);
            }

            sessions[sender] = { step: 'AWAITING_DETAILS', cart };
            return send(
                `🛒 *Order Summary:*\n${cartLines(cart)}` +
                `${billBlock(cart)}\n\n` +
                `Please share your *Name, Phone & Address*\n` +
                `_Example: Ravi, 9876543210, 12 MG Road, Delhi_\n\n` +
                `_Type *add* to add more | *empty* to clear | *cancel* to cancel_${warnMsg}`
            );
        }

        // ── Smart "Did you mean?" ─────────────────────────────────────────────
        const suggestions = getSuggestions(text, menu, 3);
        if (suggestions.length)
            return send(
                `🤔 Couldn't find "*${rawText}*"\n\n` +
                `*Did you mean:*\n${suggestions.map(s => `• ${s}`).join('\n')}\n\n` +
                `Type *menu* to browse everything!`
            );

        // ── Final fallback ────────────────────────────────────────────────────
        return send(
            `Hmm, I didn't get that! 😅\n\n` +
            `Type *menu* to browse, or just tell me what you want:\n` +
            `_cheese pizza small_\n_2 veg burger + cold coffee_`
        );
    });
}

startBot().catch(err => console.error('[Fatal]', err));

// Keep process alive — log heartbeat every 30 min
setInterval(() => {
    console.log('[Heartbeat] Bot running — ' + new Date().toLocaleString('en-IN'));
}, 30 * 60 * 1000);

// Self-exit before GitHub's 6h limit to avoid overlap with cron restart
const maxMinutes = parseInt(process.env.MAX_RUNTIME_MINUTES || '340');
setTimeout(async () => {
    console.log(`[Self-exit] ${maxMinutes} min reached — saving session and exiting cleanly...`);
    try { await saveSessionToFirebase(); } catch(e) {}
    console.log('[Self-exit] Done. Cron will restart shortly.');
    process.exit(0);
}, maxMinutes * 60 * 1000);

// Save session when GitHub Actions cancels the job (SIGTERM)
// This ensures the next job can restore the session without needing a new QR
async function gracefulShutdown(signal) {
    console.log(`[Shutdown] ${signal} received — saving session before exit...`);
    try { await saveSessionToFirebase(); } catch(e) {}
    console.log('[Shutdown] Session saved. Goodbye.');
    process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
