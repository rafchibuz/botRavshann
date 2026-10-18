const express = require('express');
const tmi = require('tmi.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const port = Number(process.env.PORT || 80);
const startTime = Date.now();
const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const configExamplePath = path.join(__dirname, 'config.example.json');
const SESSION_COOKIE = 'panel_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function loadConfig() {
    const source = fs.existsSync(configPath) ? configPath : configExamplePath;
    if (!fs.existsSync(source)) throw new Error('Скопируйте config.example.json в config.json');
    return JSON.parse(fs.readFileSync(source, 'utf-8'));
}

let config = loadConfig();
const sessions = new Map();
const timerInstances = new Map();
const busyChannels = new Set();
const pendingOutgoing = new Map();
const activityThrottle = new Map();
const commandCooldowns = new Map();
const twitchUserIds = new Map();
const oauthStates = new Map();
let ratingCache = { expiresAt: 0, data: null };

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalizeChannel = value => String(value || '').replace(/^#/, '').trim().toLowerCase();
const toIrcChannel = value => `#${normalizeChannel(value)}`;
const cleanText = (value, max = 500) => String(value || '').trim().slice(0, max);
const makeId = prefix => `${prefix}_${crypto.randomUUID()}`;
function normalizeCommand(value) {
    const command = String(value || '').trim().toLowerCase().replace(/^!+/, '').replace(/[^a-zа-яё0-9_]+/gi, '');
    return command ? `!${command.slice(0, 40)}` : '';
}

function int(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function saveConfig() {
    const temp = `${configPath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(config, null, 2), 'utf-8');
    try {
        fs.renameSync(temp, configPath);
    } catch (error) {
        // Docker не всегда разрешает атомарно заменить отдельно примонтированный файл.
        if (!['EBUSY', 'EPERM', 'EXDEV'].includes(error.code)) throw error;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        fs.unlinkSync(temp);
    }
}

function legacyTimers() {
    return (Array.isArray(config.buttons) ? config.buttons : []).map(button => ({
        id: String(button.id || makeId('timer')),
        title: cleanText(button.title || button.id || 'Таймер', 80),
        message: cleanText(button.message),
        enabled: Boolean(button.enabled),
        spamCount: int(button.spamCount, 1, 1, 20)
    }));
}

function defaultChannelState() {
    return {
        globalTimerEnabled: Boolean(config.globalTimerEnabled),
        globalTimerIntervalSeconds: int(config.globalTimerIntervalSeconds, 600, 10, 86400),
        queueIndex: 0,
        timers: legacyTimers(),
        pinnedMessages: [],
        customCommands: [],
        currentPinnedMessageId: null
    };
}

function migrateConfig() {
    config.twitch ||= {};
    config.twitch.redirectUri ||= 'http://localhost:8080';
    config.twitch.channelAuth ||= {};
    config.twitch.moderatorLogin = normalizeChannel(config.twitch.moderatorLogin || config.twitch.botUsername);
    config.twitch.oauthScopes = ['moderator:manage:chat_messages'];
    config.panelPassword ||= 'change-me';
    config.globalChatDelayMs = int(config.globalChatDelayMs, 600, 0, 30000);
    config.globalTimerIntervalSeconds = int(config.globalTimerIntervalSeconds, 600, 10, 86400);
    config.activity ||= {};
    config.activity.cooldownSeconds = int(config.activity.cooldownSeconds, 10, 1, 300);
    config.activity.publicRatingUrl ||= 'https://www.ravshan.tv/api/rating?channel=all&period=1y';
    config.activity.lookupUrl ||= 'https://www.ravshan.tv/api/rating/lookup';
    config.activity.siteUrl ||= 'https://ravshan.tv';
    config.activity.cacheSeconds = int(config.activity.cacheSeconds, 60, 5, 3600);

    const primary = normalizeChannel(config.twitch.channel);
    config.twitch.channel = primary;
    config.channels = [...new Set([primary, ...(config.channels || []).map(normalizeChannel)].filter(Boolean))];
    config.channelState ||= {};

    for (const channel of config.channels) {
        const state = config.channelState[channel] ||= defaultChannelState();
        state.globalTimerEnabled = Boolean(state.globalTimerEnabled);
        state.globalTimerIntervalSeconds = int(state.globalTimerIntervalSeconds, config.globalTimerIntervalSeconds, 10, 86400);
        state.queueIndex = int(state.queueIndex, 0, 0, Number.MAX_SAFE_INTEGER);
        if (!Array.isArray(state.timers)) {
            const old = state.buttons || {};
            state.timers = legacyTimers().map(timer => ({
                ...timer,
                enabled: Boolean(old[timer.id]?.enabled ?? timer.enabled),
                spamCount: int(old[timer.id]?.spamCount, timer.spamCount, 1, 20)
            }));
        }
        state.timers = state.timers.map(timer => ({
            id: String(timer.id || makeId('timer')),
            title: cleanText(timer.title || 'Таймер', 80),
            message: cleanText(timer.message),
            enabled: Boolean(timer.enabled),
            spamCount: int(timer.spamCount, 1, 1, 20)
        })).filter(timer => timer.message);
        state.pinnedMessages = (Array.isArray(state.pinnedMessages) ? state.pinnedMessages : []).map(pin => ({
            id: String(pin.id || makeId('pin')),
            title: cleanText(pin.title || 'Закреп', 80),
            message: cleanText(pin.message),
            durationSeconds: int(pin.durationSeconds, 300, 30, 1800)
        })).filter(pin => pin.message);
        state.customCommands = (Array.isArray(state.customCommands) ? state.customCommands : []).map(command => ({
            id: String(command.id || makeId('command')),
            command: normalizeCommand(command.command),
            response: cleanText(command.response),
            cooldownSeconds: int(command.cooldownSeconds, 10, 0, 3600),
            permission: ['everyone', 'vip', 'mod'].includes(command.permission) ? command.permission : 'everyone',
            enabled: command.enabled !== false
        })).filter(command => command.command && command.response);
        delete state.buttons;
    }
    saveConfig();
}

function getState(channel) {
    const key = normalizeChannel(channel);
    if (!config.channels.includes(key)) throw new Error('Неизвестный канал');
    return config.channelState[key] ||= defaultChannelState();
}

function quickMessages() {
    return (config.buttons || []).map(button => ({ id: String(button.id), title: cleanText(button.title || button.id, 80), message: cleanText(button.message) }));
}

function configView(channel) {
    const key = normalizeChannel(channel || config.twitch.channel);
    const state = getState(key);
    const channelAuth = config.twitch.channelAuth[key] || {};
    return {
        channels: config.channels,
        activeChannel: key,
        globalChatDelayMs: config.globalChatDelayMs,
        globalTimerEnabled: state.globalTimerEnabled,
        globalTimerIntervalSeconds: state.globalTimerIntervalSeconds,
        buttons: quickMessages(),
        timers: state.timers,
        pinnedMessages: state.pinnedMessages,
        customCommands: state.customCommands,
        pinningConfigured: Boolean(config.twitch.clientId && channelAuth.refreshToken),
        twitchAuth: {
            appConfigured: Boolean(config.twitch.clientId && config.twitch.clientSecret),
            authorized: Boolean(channelAuth.refreshToken),
            login: channelAuth.login || null,
            expiresAt: channelAuth.expiresAt || null,
            mode: 'moderator',
            expectedLogin: config.twitch.moderatorLogin
        },
        activity: { cooldownSeconds: config.activity.cooldownSeconds, exactLookupConfigured: Boolean(config.activity.lookupUrl), siteUrl: config.activity.siteUrl }
    };
}

migrateConfig();

function parseCookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
        const [key, ...rest] = part.trim().split('=');
        return key ? [key, decodeURIComponent(rest.join('='))] : [];
    }).filter(([key]) => key));
}

function validSession(token) {
    const expiresAt = sessions.get(token);
    if (!expiresAt || expiresAt < Date.now()) { if (token) sessions.delete(token); return false; }
    return true;
}

function checkPassword(input) {
    const expected = Buffer.from(String(config.panelPassword || ''));
    const actual = Buffer.from(String(input || ''));
    return expected.length > 0 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function requireAuth(req, res, next) {
    if (validSession(parseCookies(req)[SESSION_COOKIE])) return next();
    if (req.path === '/' || req.path.endsWith('.html')) return res.redirect('/login');
    return res.status(401).json({ message: 'Требуется авторизация' });
}

const client = new tmi.client({
    options: { debug: false },
    identity: { username: config.twitch.botUsername, password: config.twitch.oauthToken },
    channels: config.channels.map(toIrcChannel)
});
if (process.env.DISABLE_TWITCH !== '1') client.connect().catch(error => console.error('Ошибка Twitch IRC:', error.message));

async function runSpam(channel, message, count, delayMs) {
    const key = normalizeChannel(channel);
    if (busyChannels.has(key)) throw new Error(`Бот занят в #${key}`);
    busyChannels.add(key);
    try {
        for (let index = 0; index < count; index += 1) {
            await client.say(toIrcChannel(key), message);
            if (index < count - 1) await delay(delayMs);
        }
    } finally { busyChannels.delete(key); }
}

async function sendNext(channel) {
    const key = normalizeChannel(channel);
    const state = getState(key);
    const active = state.timers.filter(timer => timer.enabled && timer.message);
    if (!active.length || busyChannels.has(key)) return;
    const target = active[state.queueIndex % active.length];
    state.queueIndex = (state.queueIndex + 1) % active.length;
    saveConfig();
    runSpam(key, target.message, target.spamCount, config.globalChatDelayMs).catch(error => console.error(`[ТАЙМЕР #${key}]`, error.message));
}

function syncTimer(channel) {
    const key = normalizeChannel(channel);
    if (timerInstances.has(key)) clearInterval(timerInstances.get(key));
    timerInstances.delete(key);
    const state = getState(key);
    if (state.globalTimerEnabled) timerInstances.set(key, setInterval(() => sendNext(key), state.globalTimerIntervalSeconds * 1000));
}

function timerStatus(channel) {
    const state = getState(channel);
    const enabled = state.timers.filter(timer => timer.enabled).map(timer => timer.title);
    return `[Таймеры | цикл ${state.globalTimerEnabled ? 'вкл' : 'выкл'}] активны: ${enabled.join(', ') || 'нет'}`;
}

function findTimer(state, token) {
    const aliases = { 'тг': 'tg', tg: 'tg', 'гта': 'majestic', gta: 'majestic', 'маджестик': 'majestic', majestic: 'majestic', 'бб': 'betboom', bb: 'betboom', 'бетбум': 'betboom', betboom: 'betboom', 'фоллоу': 'follow', 'ф': 'follow', follow: 'follow', 'приора': 'priora', 'розыгрыш': 'priora', 'роз': 'priora', priora: 'priora', 'общага': 'obshaga', 'отг': 'obshaga', obshaga: 'obshaga', 'инт': 'int', int: 'int' };
    const value = String(token || '').toLowerCase();
    return state.timers.find(timer => timer.id === (aliases[value] || value) || timer.title.toLowerCase() === value);
}

const reservedCommands = new Set(['!актив', '!active', '!пинг', '!ping', '!таймер', '!таймерофф', '!таймероф', '!таймеры']);
function validateCustomCommand(body, existingId, channel) {
    const command = normalizeCommand(body.command);
    const response = cleanText(body.response);
    if (!command) throw new Error('Введите команду, например !сайт');
    if (reservedCommands.has(command)) throw new Error('Эта команда встроена в бота и не может быть заменена');
    if (!response) throw new Error('Введите текст ответа');
    const state = getState(channel);
    if (state.customCommands.some(item => item.id !== existingId && item.command === command)) throw new Error('Такая команда уже существует');
    return {
        command,
        response,
        cooldownSeconds: int(body.cooldownSeconds, 10, 0, 3600),
        permission: ['everyone', 'vip', 'mod'].includes(body.permission) ? body.permission : 'everyone',
        enabled: body.enabled !== false
    };
}

function canUseCustomCommand(tags, permission, channel) {
    const isBroadcaster = normalizeChannel(tags.username) === normalizeChannel(channel);
    const isMod = Boolean(tags.mod) || isBroadcaster;
    return permission === 'everyone' || (permission === 'vip' && (isMod || Boolean(tags.vip) || Boolean(tags.badges?.vip))) || (permission === 'mod' && isMod);
}

async function runCustomCommand(channel, tags, definition) {
    const key = normalizeChannel(channel);
    if (!canUseCustomCommand(tags, definition.permission, key)) return;
    const cooldownKey = `${key}:${definition.id}`;
    const lastUsedAt = commandCooldowns.get(cooldownKey) || 0;
    if (Date.now() - lastUsedAt < definition.cooldownSeconds * 1000) return;
    commandCooldowns.set(cooldownKey, Date.now());
    const displayName = tags['display-name'] || tags.username;
    const response = definition.response
        .replaceAll('{user}', `@${displayName}`)
        .replaceAll('{login}', tags.username)
        .replaceAll('{channel}', key);
    if (typeof client.reply === 'function' && tags.id) await client.reply(channel, response, tags.id);
    else await client.say(channel, response);
}

function getChannelAuth(channel) {
    const key = normalizeChannel(channel || config.twitch.channel);
    return config.twitch.channelAuth[key] ||= {};
}

async function refreshAccessToken(channel) {
    const key = normalizeChannel(channel || config.twitch.channel);
    const auth = getChannelAuth(key);
    if (!auth.refreshToken || !config.twitch.clientSecret) {
        throw new Error('Подключите Twitch в панели управления');
    }
    const form = new URLSearchParams({
        client_id: config.twitch.clientId,
        client_secret: config.twitch.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: auth.refreshToken
    });
    const response = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || `Не удалось обновить Twitch OAuth: HTTP ${response.status}`);
    auth.accessToken = body.access_token;
    auth.refreshToken = body.refresh_token || auth.refreshToken;
    auth.expiresAt = Date.now() + Number(body.expires_in || 0) * 1000;
    auth.scopes = body.scope || auth.scopes || [];
    saveConfig();
    return body.access_token;
}

async function validBearer(channel) {
    const auth = getChannelAuth(channel);
    if (auth.refreshToken && (!auth.expiresAt || auth.expiresAt < Date.now() + 300000)) {
        return refreshAccessToken(channel);
    }
    if (!auth.accessToken) throw new Error('Подключите аккаунт владельца канала в панели');
    return auth.accessToken;
}

async function exchangeAuthorizationCode(code, channel) {
    const key = normalizeChannel(channel);
    const form = new URLSearchParams({
        client_id: config.twitch.clientId,
        client_secret: config.twitch.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: config.twitch.redirectUri
    });
    const response = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || `Twitch OAuth: HTTP ${response.status}`);
    const validationResponse = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${body.access_token}` } });
    const validation = await validationResponse.json().catch(() => ({}));
    if (!validationResponse.ok) throw new Error(validation.message || 'Не удалось проверить Twitch OAuth');
    if (normalizeChannel(validation.login) !== config.twitch.moderatorLogin) {
        throw new Error(`Войдите в Twitch как ${config.twitch.moderatorLogin}, сейчас выбран аккаунт ${validation.login || 'неизвестен'}`);
    }
    config.twitch.channelAuth[key] = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + Number(body.expires_in || 0) * 1000,
        scopes: body.scope || [],
        userId: validation.user_id,
        login: normalizeChannel(validation.login)
    };
    saveConfig();
}

async function helix(url, options = {}, authChannel = config.twitch.channel) {
    if (!config.twitch.clientId) throw new Error('В config.json не указан twitch.clientId');
    const accessToken = await validBearer(authChannel);
    const response = await fetch(`https://api.twitch.tv/helix${url}`, {
        ...options,
        headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': config.twitch.clientId, 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || `Twitch API: HTTP ${response.status}`);
    return body;
}

async function twitchUserId(login, authChannel = config.twitch.channel) {
    const key = normalizeChannel(login);
    if (twitchUserIds.has(key)) return twitchUserIds.get(key);
    const body = await helix(`/users?login=${encodeURIComponent(key)}`, {}, authChannel);
    const id = body?.data?.[0]?.id;
    if (!id) throw new Error(`Twitch-пользователь ${key} не найден`);
    twitchUserIds.set(key, id);
    return id;
}

function channelAuthUserId(channel) {
    const auth = getChannelAuth(channel);
    if (!auth.userId) throw new Error('Переподключите Twitch-аккаунт владельца выбранного канала');
    return auth.userId;
}

function waitMessageId(channel, message) {
    const key = normalizeChannel(channel);
    return new Promise((resolve, reject) => {
        const waiter = { message, resolve, reject };
        waiter.timer = setTimeout(() => {
            pendingOutgoing.set(key, (pendingOutgoing.get(key) || []).filter(item => item !== waiter));
            reject(new Error('Twitch не вернул ID отправленного сообщения'));
        }, 7000);
        pendingOutgoing.set(key, [...(pendingOutgoing.get(key) || []), waiter]);
    });
}

function resolveMessageId(channel, tags, message) {
    const key = normalizeChannel(channel);
    const queue = pendingOutgoing.get(key) || [];
    const index = queue.findIndex(waiter => waiter.message === message);
    if (index < 0) return;
    const [waiter] = queue.splice(index, 1);
    pendingOutgoing.set(key, queue);
    clearTimeout(waiter.timer);
    tags.id ? waiter.resolve(tags.id) : waiter.reject(new Error('Twitch не прислал ID сообщения'));
}

async function sendAndPin(channel, message, durationSeconds) {
    const key = normalizeChannel(channel);
    const idPromise = waitMessageId(key, message);
    await client.say(toIrcChannel(key), message);
    const messageId = await idPromise;
    const params = new URLSearchParams({
        broadcaster_id: await twitchUserId(key, key), moderator_id: channelAuthUserId(key),
        message_id: messageId, duration_seconds: String(int(durationSeconds, 300, 30, 1800))
    });
    await helix(`/chat/pins?${params}`, { method: 'PUT' }, key);
    getState(key).currentPinnedMessageId = messageId;
    saveConfig();
}

async function unpin(channel) {
    const key = normalizeChannel(channel);
    const state = getState(key);
    if (!state.currentPinnedMessageId) throw new Error('У бота нет ID текущего закрепа');
    const params = new URLSearchParams({ broadcaster_id: await twitchUserId(key, key), moderator_id: channelAuthUserId(key), message_id: state.currentPinnedMessageId });
    await helix(`/chat/pins?${params}`, { method: 'DELETE' }, key);
    state.currentPinnedMessageId = null;
    saveConfig();
}

async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Рейтинг: HTTP ${response.status}`);
    return response.json();
}

async function lookupRating(login) {
    const normalized = normalizeChannel(login);
    if (config.activity.lookupUrl) {
        try {
            const template = config.activity.lookupUrl;
            const url = template.includes('{login}') ? template.replaceAll('{login}', encodeURIComponent(normalized)) : `${template}${template.includes('?') ? '&' : '?'}login=${encodeURIComponent(normalized)}&channel=all&period=1y`;
            const body = await fetchJson(url);
            const entry = body?.data?.item || body?.data || body;
            if (Number.isFinite(Number(entry?.rank))) return { entry, exact: true };
        } catch (error) {
            console.warn('[РЕЙТИНГ LOOKUP]', error.message, '— использую публичный топ');
        }
    }
    if (!ratingCache.data || ratingCache.expiresAt <= Date.now()) {
        const body = await fetchJson(config.activity.publicRatingUrl);
        ratingCache = { data: body?.data || body, expiresAt: Date.now() + config.activity.cacheSeconds * 1000 };
    }
    const items = ratingCache.data?.items || [];
    return { entry: items.find(item => normalizeChannel(item.login) === normalized) || null, limitedToTop: items.length };
}

async function activityReply(channel, tags) {
    const name = tags['display-name'] || tags.username;
    let text;
    try {
        const result = await lookupRating(tags.username);
        text = result.entry
            ? `@${name}, ваше место в рейтинге — #${result.entry.rank}. Более подробная информация на сайте ${config.activity.siteUrl.replace(/^https?:\/\//, '')}`
            : `@${name}, точное место пока недоступно: публичный рейтинг показывает только топ-${result.limitedToTop || 100}. Более подробная информация на сайте ${config.activity.siteUrl.replace(/^https?:\/\//, '')}`;
    } catch (error) {
        console.error('[!АКТИВ]', error.message);
        text = `@${name}, сейчас не удалось получить рейтинг. Попробуйте позже.`;
    }
    try {
        if (typeof client.reply === 'function' && tags.id) await client.reply(channel, text, tags.id);
        else await client.say(channel, text);
    } catch (error) { console.error('[!АКТИВ ОТВЕТ]', error.message); }
}

function queueActivityReply(channel, tags) {
    const key = normalizeChannel(channel);
    const state = activityThrottle.get(key) || { lastSentAt: 0, pending: null, timer: null };
    state.pending = { channel, tags };
    const remaining = Math.max(0, config.activity.cooldownSeconds * 1000 - (Date.now() - state.lastSentAt));
    const fire = () => {
        const current = activityThrottle.get(key);
        if (!current?.pending) return;
        const request = current.pending;
        current.pending = null; current.timer = null; current.lastSentAt = Date.now();
        activityThrottle.set(key, current);
        activityReply(request.channel, request.tags);
    };
    if (!remaining && !state.timer) { activityThrottle.set(key, state); fire(); return; }
    if (!state.timer) state.timer = setTimeout(fire, remaining);
    activityThrottle.set(key, state);
}

app.use(express.json({ limit: '100kb' }));
app.get('/', async (req, res, next) => {
    if (!req.query.code && !req.query.error) return next();
    const pending = oauthStates.get(String(req.query.state || ''));
    oauthStates.delete(String(req.query.state || ''));
    if (!pending || pending.expiresAt < Date.now()) return res.status(400).send('OAuth state истёк. Вернитесь в панель и подключите Twitch заново.');
    if (req.query.error) return res.status(400).send(`Twitch OAuth отклонён: ${cleanText(req.query.error_description || req.query.error, 300)}`);
    try {
        await exchangeAuthorizationCode(String(req.query.code), pending.channel);
        return res.redirect(`/?twitch=connected&channel=${encodeURIComponent(pending.channel)}`);
    } catch (error) {
        return res.status(400).send(`Ошибка Twitch OAuth: ${cleanText(error.message, 300)}`);
    }
});
app.get('/login', (req, res) => validSession(parseCookies(req)[SESSION_COOKIE]) ? res.redirect('/') : res.sendFile(path.join(__dirname, 'login.html')));
app.post('/login', (req, res) => {
    if (!checkPassword(req.body.password)) return res.status(401).json({ message: 'Неверный пароль' });
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`);
    res.json({ success: true });
});
app.post('/logout', (req, res) => { sessions.delete(parseCookies(req)[SESSION_COOKIE]); res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`); res.json({ success: true }); });
app.get('/auth/check', (req, res) => res.json({ authenticated: validSession(parseCookies(req)[SESSION_COOKIE]) }));
app.use(requireAuth);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/get-config', (req, res) => { try { res.json(configView(req.query.channel)); } catch (error) { res.status(400).json({ message: error.message }); } });
app.get('/get-channels', (req, res) => res.json(config.channels));
app.get('/auth/twitch/start', (req, res) => {
    if (!config.twitch.clientId || !config.twitch.clientSecret) return res.status(400).send('Сначала укажите Twitch Client ID и Client Secret');
    const channel = normalizeChannel(req.query.channel || config.twitch.channel);
    if (!config.channels.includes(channel)) return res.status(400).send('Неизвестный канал');
    const state = crypto.randomBytes(24).toString('hex');
    oauthStates.set(state, { expiresAt: Date.now() + 10 * 60 * 1000, channel });
    const params = new URLSearchParams({
        client_id: config.twitch.clientId,
        redirect_uri: config.twitch.redirectUri,
        response_type: 'code',
        scope: config.twitch.oauthScopes.join(' '),
        state,
        force_verify: 'true'
    });
    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

app.post('/toggle-global-timer', (req, res) => {
    const channel = normalizeChannel(req.body.channel || config.twitch.channel);
    const state = getState(channel);
    state.globalTimerIntervalSeconds = int(req.body.interval, state.globalTimerIntervalSeconds, 10, 86400);
    state.globalTimerEnabled = req.body.action === 'start';
    if (state.globalTimerEnabled) state.queueIndex = 0;
    saveConfig(); syncTimer(channel);
    res.json({ enabled: state.globalTimerEnabled, message: `Цикл таймеров ${state.globalTimerEnabled ? 'запущен' : 'остановлен'} для #${channel}` });
});

app.post('/api/timers', (req, res) => {
    const state = getState(req.body.channel || config.twitch.channel);
    const message = cleanText(req.body.message);
    if (!message) return res.status(400).json({ message: 'Введите текст таймера' });
    const timer = { id: makeId('timer'), title: cleanText(req.body.title || 'Новый таймер', 80), message, enabled: Boolean(req.body.enabled), spamCount: int(req.body.spamCount, 1, 1, 20) };
    state.timers.push(timer); saveConfig(); res.status(201).json({ timer });
});
app.put('/api/timers/:id', (req, res) => {
    const channel = normalizeChannel(req.body.channel || config.twitch.channel);
    const state = getState(channel); const timer = state.timers.find(item => item.id === req.params.id);
    if (!timer) return res.status(404).json({ message: 'Таймер не найден' });
    if (req.body.title !== undefined) timer.title = cleanText(req.body.title, 80) || timer.title;
    if (req.body.message !== undefined) { const message = cleanText(req.body.message); if (!message) return res.status(400).json({ message: 'Текст не может быть пустым' }); timer.message = message; }
    if (req.body.enabled !== undefined) timer.enabled = Boolean(req.body.enabled);
    if (req.body.spamCount !== undefined) timer.spamCount = int(req.body.spamCount, timer.spamCount, 1, 20);
    saveConfig(); res.json({ timer, timers: state.timers });
});
app.delete('/api/timers/:id', (req, res) => {
    const state = getState(req.query.channel || config.twitch.channel); const before = state.timers.length;
    state.timers = state.timers.filter(item => item.id !== req.params.id);
    if (state.timers.length === before) return res.status(404).json({ message: 'Таймер не найден' });
    state.queueIndex = 0; saveConfig(); res.json({ success: true });
});
app.post('/api/timers/:id/send', async (req, res) => {
    const channel = normalizeChannel(req.body.channel || config.twitch.channel); const timer = getState(channel).timers.find(item => item.id === req.params.id);
    if (!timer) return res.status(404).json({ message: 'Таймер не найден' });
    try { await runSpam(channel, timer.message, timer.spamCount, config.globalChatDelayMs); res.json({ success: true, message: `«${timer.title}» отправлен` }); }
    catch (error) { res.status(409).json({ message: error.message }); }
});

app.post('/api/commands', (req, res) => {
    try {
        const channel = normalizeChannel(req.body.channel || config.twitch.channel);
        const state = getState(channel);
        const command = { id: makeId('command'), ...validateCustomCommand(req.body, null, channel) };
        state.customCommands.push(command); saveConfig(); res.status(201).json({ command });
    } catch (error) { res.status(400).json({ message: error.message }); }
});
app.put('/api/commands/:id', (req, res) => {
    try {
        const channel = normalizeChannel(req.body.channel || config.twitch.channel);
        const state = getState(channel); const command = state.customCommands.find(item => item.id === req.params.id);
        if (!command) return res.status(404).json({ message: 'Команда не найдена' });
        Object.assign(command, validateCustomCommand({ ...command, ...req.body }, command.id, channel));
        saveConfig(); res.json({ command });
    } catch (error) { res.status(400).json({ message: error.message }); }
});
app.delete('/api/commands/:id', (req, res) => {
    try {
        const state = getState(req.query.channel || config.twitch.channel); const before = state.customCommands.length;
        state.customCommands = state.customCommands.filter(item => item.id !== req.params.id);
        if (state.customCommands.length === before) return res.status(404).json({ message: 'Команда не найдена' });
        commandCooldowns.forEach((_value, key) => { if (key.endsWith(`:${req.params.id}`)) commandCooldowns.delete(key); });
        saveConfig(); res.json({ success: true });
    } catch (error) { res.status(400).json({ message: error.message }); }
});

app.post('/api/pins', (req, res) => {
    const state = getState(req.body.channel || config.twitch.channel); const message = cleanText(req.body.message);
    if (!message) return res.status(400).json({ message: 'Введите текст закрепа' });
    const pin = { id: makeId('pin'), title: cleanText(req.body.title || 'Новый закреп', 80), message, durationSeconds: int(req.body.durationSeconds, 300, 30, 1800) };
    state.pinnedMessages.push(pin); saveConfig(); res.status(201).json({ pin });
});
app.put('/api/pins/:id', (req, res) => {
    const state = getState(req.body.channel || config.twitch.channel); const pin = state.pinnedMessages.find(item => item.id === req.params.id);
    if (!pin) return res.status(404).json({ message: 'Закреп не найден' });
    if (req.body.title !== undefined) pin.title = cleanText(req.body.title, 80) || pin.title;
    if (req.body.message !== undefined) { const message = cleanText(req.body.message); if (!message) return res.status(400).json({ message: 'Текст не может быть пустым' }); pin.message = message; }
    if (req.body.durationSeconds !== undefined) pin.durationSeconds = int(req.body.durationSeconds, pin.durationSeconds, 30, 1800);
    saveConfig(); res.json({ pin });
});
app.delete('/api/pins/:id', (req, res) => {
    const state = getState(req.query.channel || config.twitch.channel); const before = state.pinnedMessages.length;
    state.pinnedMessages = state.pinnedMessages.filter(item => item.id !== req.params.id);
    if (state.pinnedMessages.length === before) return res.status(404).json({ message: 'Закреп не найден' });
    saveConfig(); res.json({ success: true });
});
app.post('/api/pins/:id/send', async (req, res) => {
    const channel = normalizeChannel(req.body.channel || config.twitch.channel); const pin = getState(channel).pinnedMessages.find(item => item.id === req.params.id);
    if (!pin) return res.status(404).json({ message: 'Закреп не найден' });
    try { await sendAndPin(channel, pin.message, pin.durationSeconds); res.json({ success: true, message: `Сообщение закреплено в #${channel}` }); }
    catch (error) { res.status(400).json({ message: error.message }); }
});
app.delete('/api/pins/current', async (req, res) => { try { await unpin(req.query.channel || config.twitch.channel); res.json({ success: true, message: 'Закреп снят' }); } catch (error) { res.status(400).json({ message: error.message }); } });

app.post('/start-spam', async (req, res) => {
    const target = quickMessages().find(button => button.id === req.body.id); if (!target) return res.status(404).json({ message: 'Кнопка не найдена' });
    try { await runSpam(req.body.channel, target.message, int(req.body.count, 1, 1, 50), config.globalChatDelayMs); res.json({ success: true, message: `«${target.title}» отправлено` }); } catch (error) { res.status(409).json({ message: error.message }); }
});
app.post('/start-custom-spam', async (req, res) => {
    const message = cleanText(req.body.message); if (!message) return res.status(400).json({ message: 'Пустое сообщение' });
    try { await runSpam(req.body.channel, message, int(req.body.count, 1, 1, 50), int(req.body.delayMs, config.globalChatDelayMs, 0, 30000)); res.json({ success: true, message: 'Сообщение отправлено' }); } catch (error) { res.status(409).json({ message: error.message }); }
});
app.get('/get-stream-title', async (req, res) => {
    try {
        const channel = normalizeChannel(req.query.channel || config.twitch.channel);
        const body = await helix(`/channels?broadcaster_id=${encodeURIComponent(await twitchUserId(channel, channel))}`, {}, channel);
        const info = body?.data?.[0] || {};
        res.json({ title: info.title || 'Без названия', game: info.game_name || 'Без категории', gameId: info.game_id || null });
    } catch (error) { res.status(400).json({ message: error.message }); }
});
app.get('/get-pinned-message', async (req, res) => {
    try {
        const channel = normalizeChannel(req.query.channel || config.twitch.channel);
        const params = new URLSearchParams({
            broadcaster_id: await twitchUserId(channel, channel),
            moderator_id: channelAuthUserId(channel)
        });
        const body = await helix(`/chat/pins?${params}`, {}, channel);
        const pinned = body?.data?.[0] || null;
        const state = getState(channel);
        const messageId = pinned?.message_id || null;
        if (state.currentPinnedMessageId !== messageId) {
            state.currentPinnedMessageId = messageId;
            saveConfig();
        }
        res.json({
            pinned: Boolean(pinned),
            messageId,
            text: pinned?.message?.text || '',
            sender: pinned?.sender_user_name || pinned?.sender_user_login || '',
            pinnedBy: pinned?.pinned_by_user_name || pinned?.pinned_by_user_login || '',
            startsAt: pinned?.starts_at || null,
            endsAt: pinned?.ends_at || null,
            updatedAt: pinned?.updated_at || null
        });
    } catch (error) { res.status(400).json({ message: error.message }); }
});
const ownerOnly = (_req, res) => res.status(403).json({ message: 'Twitch разрешает это действие только владельцу канала' });
app.post('/send-set-title', ownerOnly);
app.post('/send-set-game', ownerOnly);
app.post('/api/polls', ownerOnly);
app.post('/api/predictions', ownerOnly);

client.on('message', async (channel, tags, message, self) => {
    if (self) { resolveMessageId(channel, tags, message); return; }
    if (!tags.username) return;
    const key = normalizeChannel(channel); const args = message.trim().toLowerCase().split(/\s+/); const command = args[0];
    if (command === '!актив' || command === '!active') { queueActivityReply(channel, tags); return; }
    const mod = Boolean(tags.mod) || normalizeChannel(tags.username) === key; const state = getState(key);
    if (mod && command === '!таймер') {
        args.slice(1).forEach(token => { const timer = findTimer(state, token); if (timer) timer.enabled = true; }); saveConfig(); await client.say(channel, timerStatus(key)); return;
    }
    if (mod && (command === '!таймерофф' || command === '!таймероф')) {
        if (['все', 'всё', 'all'].includes(args[1])) { state.timers.forEach(timer => { timer.enabled = false; }); state.globalTimerEnabled = false; syncTimer(key); }
        else args.slice(1).forEach(token => { const timer = findTimer(state, token); if (timer) timer.enabled = false; });
        saveConfig(); await client.say(channel, timerStatus(key)); return;
    }
    if (mod && command === '!таймеры') {
        if (['старт', 'запуск'].includes(args[1])) state.globalTimerEnabled = true;
        if (['стоп', 'выкл'].includes(args[1])) state.globalTimerEnabled = false;
        state.queueIndex = 0; saveConfig(); syncTimer(key); await client.say(channel, timerStatus(key)); return;
    }
    if (command === '!пинг' || command === '!ping') {
        const seconds = Math.floor((Date.now() - startTime) / 1000); await client.say(channel, `Понг! 🏓 Аптайм: ${Math.floor(seconds / 3600)}ч ${Math.floor(seconds % 3600 / 60)}м ${seconds % 60}с`); return;
    }
    const customCommand = state.customCommands.find(item => item.enabled && item.command === normalizeCommand(command));
    if (customCommand) {
        try { await runCustomCommand(channel, tags, customCommand); } catch (error) { console.error('[КОМАНДА]', error.message); }
        return;
    }
    const aliases = { '!тг': 'tg', '!гта': 'majestic', '!бб': 'betboom', '!фоллоу': 'follow', '!ф': 'follow', '!розыгрыш': 'priora', '!приора': 'priora', '!роз': 'priora', '!общага': 'obshaga', '!отг': 'obshaga', '!инт': 'int' };
    const target = quickMessages().find(button => button.id === aliases[command]);
    if (!target || busyChannels.has(key)) return;
    try { await runSpam(key, mod ? target.message : `@${tags['display-name'] || tags.username}, ${target.message}`, mod ? int(args[1], 5, 1, 50) : 1, config.globalChatDelayMs); } catch (error) { console.error(error.message); }
});

config.channels.forEach(channel => { if (getState(channel).globalTimerEnabled) syncTimer(channel); });
const server = app.listen(port, '0.0.0.0', () => console.log(`Панель: http://localhost:${port}\nКаналы: ${config.channels.map(channel => `#${channel}`).join(', ')}`));
function shutdown() { timerInstances.forEach(clearInterval); activityThrottle.forEach(item => item.timer && clearTimeout(item.timer)); server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
module.exports = { app, lookupRating, queueActivityReply, normalizeChannel };
