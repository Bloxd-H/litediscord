const API_BASE = 'https://discord.com/api/v10';
let ws, currentAccount, currentChannel, lastSequence, heartbeatInterval, timeoutInterval;
let replyingTo = null;
let oldestMessageId = null;
let pingCounts = {};
let isLoadingMore = false;
let attachedFile = null;
let commandDebounce = null;
let memberDebounce = null;
let maxCharCount = 2000;
let guildFolders = []; 
let guildDataMap = new Map();
let openFolderId = null; // Currently open folder

// Storage for plugins
let messageStore = {}; 
let editedMessages = {}; // Stores edit history

const plugins = JSON.parse(localStorage.getItem('plugins')) || {
    showMeYourName: false,
    sendSeconds: false,
    messageLogger: true,
    clickAction: true // Double click reply
};

const getAccounts = () => JSON.parse(localStorage.getItem('accounts')) || [];
const saveAccounts = a => localStorage.setItem('accounts', JSON.stringify(a));
const getActiveAccountId = () => localStorage.getItem('activeAccountId');
const setActiveAccountId = id => localStorage.setItem('activeAccountId', id);

const generateSuperProperties = () => btoa(JSON.stringify({ os: "Windows", browser: "Chrome", device: "", system_locale: "ja", browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", browser_version: "120.0.0.0", os_version: "10", release_channel: "stable", client_build_number: 262355 }));

function cleanupState() {
    if (ws) { ws.onclose = null; ws.close(); }
    ws = null; currentChannel = null; lastSequence = null; attachedFile = null;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (timeoutInterval) clearInterval(timeoutInterval);
    document.getElementById('guild-list').innerHTML = '';
    document.getElementById('channel-list').innerHTML = '';
    document.getElementById('message-container').innerHTML = '';
    document.getElementById('guild-name').innerText = '';
    messageStore = {}; guildFolders = []; guildDataMap.clear();
    editedMessages = {};
    cancelReply(); cancelAttachment();
}

async function apiRequest(token, path, method = 'GET', body = null, isFormData = false) {
    const o = { method, headers: { 'Authorization': token, 'X-Super-Properties': generateSuperProperties() } };
    if (body) {
        if (isFormData) { o.body = body } else { o.body = JSON.stringify(body); o.headers['Content-Type'] = 'application/json'; }
    }
    try {
        const r = await fetch(`${API_BASE}${path}`, o);
        if (r.status === 401) return { error: { message: "Unauthorized" }, status: 401 };
        const data = r.status === 204 ? {} : await r.json();
        if (!r.ok) return { error: data, status: r.status };
        return { data, status: r.status };
    } catch (e) {
        return { error: { message: "Network error" }, status: 0 };
    }
}

// ---------------- VIEWS ----------------
function updateView(viewName) {
    const authSection = document.getElementById('auth-section');
    const mainApp = document.getElementById('main-app');
    if (viewName === 'auth') {
        authSection.classList.remove('hidden'); authSection.classList.add('flex');
        mainApp.classList.add('hidden'); mainApp.classList.remove('flex');
    } else if (viewName === 'app') {
        authSection.classList.add('hidden'); authSection.classList.remove('flex');
        mainApp.classList.remove('hidden'); mainApp.classList.add('flex');
        if (window.innerWidth < 768) showSidebarView();
    }
}

function showLoginScreen(reloginAccount = null) {
    cleanupState(); updateView('auth');
    document.getElementById('migration-view').classList.add('hidden');
    document.getElementById('token-input-view').classList.add('hidden');
    renderSavedAccountsList();
    const accounts = getAccounts();
    if (accounts.length > 0 && !reloginAccount) {
        document.getElementById('account-selection-view').classList.remove('hidden');
        document.getElementById('account-selection-view').classList.add('flex');
    } else {
        showTokenInput(reloginAccount);
    }
}

function showTokenInput(account) {
    document.getElementById('account-selection-view').classList.add('hidden');
    document.getElementById('account-selection-view').classList.remove('flex');
    document.getElementById('token-input-view').classList.remove('hidden');
    document.getElementById('token-input-view').classList.add('flex');
    document.getElementById('token-input').value = '';
    const userInfo = document.getElementById('relogin-user-info');
    if (account) {
        document.getElementById('auth-title').innerText = '再ログイン';
        userInfo.classList.remove('hidden'); userInfo.classList.add('flex');
        document.getElementById('relogin-name').innerText = account.global_name || account.username;
        document.getElementById('relogin-username').innerText = account.username;
        const avatar = account.avatar ? `https://cdn.discordapp.com/avatars/${account.id}/${account.avatar}.png?size=128` : `https://cdn.discordapp.com/embed/avatars/${account.discriminator % 5}.png`;
        document.getElementById('relogin-avatar').src = avatar;
        document.getElementById('token-label').innerText = '新しいトークン';
        document.getElementById('add-account-button-text').innerText = 'アカウントを更新';
        document.getElementById('add-account-button').onclick = () => addAccount(document.getElementById('token-input').value, account.id);
    } else {
        document.getElementById('auth-title').innerText = 'アカウントを追加';
        userInfo.classList.add('hidden'); userInfo.classList.remove('flex');
        document.getElementById('token-label').innerText = 'トークン';
        document.getElementById('add-account-button-text').innerText = 'ログイン';
        document.getElementById('add-account-button').onclick = () => addAccount(document.getElementById('token-input').value);
    }
}

function renderSavedAccountsList() {
    const list = document.getElementById('saved-accounts-list');
    const accounts = getAccounts();
    list.innerHTML = '';
    accounts.forEach(acc => {
        const div = document.createElement('div');
        div.className = "flex items-center gap-3 p-3 border rounded hover:bg-gray-100 dark:hover:bg-gray-600 cursor-pointer transition-colors";
        div.style.borderColor = 'var(--border-color)';
        const avatar = acc.avatar ? `https://cdn.discordapp.com/avatars/${acc.id}/${acc.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${acc.discriminator % 5}.png`;
        div.innerHTML = `<img src="${avatar}" class="w-10 h-10 rounded-full bg-gray-300"><div class="flex-1 min-w-0"><div class="font-bold truncate">${acc.global_name || acc.username}</div><div class="text-xs text-[var(--text-secondary)] truncate">@${acc.username}</div></div><div class="delete-btn p-2 text-gray-400 hover:text-red-500 rounded-full" title="削除"><svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clip-rule="evenodd"></path></svg></div>`;
        div.onclick = (e) => { if (e.target.closest('.delete-btn')) return; switchAccount(acc.id); };
        div.querySelector('.delete-btn').onclick = (e) => deleteAccount(acc.id, e);
        list.appendChild(div);
    });
}

// ---------------- ACCOUNT & WS ----------------
async function migrateOldData() {
    // Legacy migration code
    return false; // Skip for now
}

async function addAccount(token, existingId = null) {
    document.getElementById('login-error').innerText = "";
    if (!token || !token.trim()) return;
    token = token.trim().replace(/^"|"$/g, '');
    const b = document.getElementById('add-account-button'), t = document.getElementById('add-account-button-text'), s = document.getElementById('login-spinner');
    t.classList.add('hidden'); s.classList.remove('hidden'); b.disabled = true;
    const result = await apiRequest(token, '/users/@me');
    t.classList.remove('hidden'); s.classList.add('hidden'); b.disabled = false;
    if (result.data && result.data.id) {
        let a = getAccounts(); 
        if(existingId && existingId !== result.data.id) return document.getElementById('login-error').innerText = "別のアカウントのトークンです";
        const idx = a.findIndex(acc => acc.id === result.data.id);
        const n = { ...result.data, token };
        if (idx > -1) a[idx] = n; else a.push(n);
        saveAccounts(a); switchAccount(result.data.id);
    } else { document.getElementById('login-error').innerText = `エラー: ${result.error?.message || '無効なトークン'}`; }
}

function switchAccount(id) {
    cleanupState(); setActiveAccountId(id);
    const a = getAccounts().find(a => a.id === id);
    if (!a) { showLoginScreen(); return }
    currentAccount = a;
    
    // Nitro check logic
    // Premium types: 0=None, 1=Classic, 2=Nitro, 3=Basic
    maxCharCount = (currentAccount.premium_type === 2) ? 4000 : 2000;

    document.getElementById('token-input').value = '';
    updateView('app');
    renderCurrentUserPanel();
    loadGuilds();
    setTimeout(connectWS, 100);
}

function renderCurrentUserPanel() {
    if (!currentAccount) return;
    const nameEl = document.getElementById('current-user-name');
    const subEl = document.getElementById('current-user-subtext');
    const avCont = document.getElementById('current-user-avatar-container');
    
    nameEl.textContent = currentAccount.global_name || currentAccount.username;
    subEl.textContent = `@${currentAccount.username}`;
    
    const avatar = currentAccount.avatar 
        ? `https://cdn.discordapp.com/avatars/${currentAccount.id}/${currentAccount.avatar}.png?size=64` 
        : `https://cdn.discordapp.com/embed/avatars/${currentAccount.discriminator % 5}.png`;
        
    let deco = '';
    if(currentAccount.avatar_decoration_data) {
        const decoUrl = `https://cdn.discordapp.com/avatar-decoration-presets/${currentAccount.avatar_decoration_data.asset}.png?size=96`;
        deco = `<img src="${decoUrl}" class="avatar-decoration" style="width: 120%; height: 120%; top: -10%; left: -10%;">`;
    }
    
    avCont.innerHTML = `<img src="${avatar}" class="avatar-img relative z-10 bg-gray-500 rounded-full">${deco}`;
    renderAccountSwitcher();
    document.getElementById('open-settings-btn').onclick = renderSettingsModal;
}

function renderAccountSwitcher() {
    const l = document.getElementById('account-list'), a = getAccounts(), i = getActiveAccountId();
    l.innerHTML = a.map(acc => {
        const av = acc.avatar ? `https://cdn.discordapp.com/avatars/${acc.id}/${acc.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${acc.discriminator % 5}.png`;
        const isA = acc.id === i;
        return `<div class="flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-[var(--button-bg)] hover:text-white group" onclick="switchAccount('${acc.id}')"><img src="${av}" class="w-8 h-8 rounded-full"><span class="flex-1 truncate text-sm font-semibold">${acc.global_name || acc.username}</span> ${isA ? '<div class="w-2 h-2 rounded-full bg-green-500"></div>' : ''} <div onclick="deleteAccount('${acc.id}',event)" title="削除" class="hidden group-hover:block p-1 hover:bg-black/20 rounded-full"><svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"></path></svg></div></div>`;
    }).join('');
}

function deleteAccount(id, e) {
    if(e) e.stopPropagation(); 
    if (!e.shiftKey && !confirm("このアカウントを削除しますか？ (Shift+Clickでスキップ)")) return;
    let a = getAccounts(); a = a.filter(acc => acc.id !== id); saveAccounts(a);
    if (getActiveAccountId() === id || !getActiveAccountId()) { localStorage.removeItem('activeAccountId'); showLoginScreen(); }
    else { renderSavedAccountsList(); renderCurrentUserPanel(); }
}

// ---------------- GUILDS & FOLDERS ----------------
async function loadGuilds() {
    if (!currentAccount) return;
    const res = await apiRequest(currentAccount.token, '/users/@me/guilds');
    if (res.error) return res.status === 401 ? showLoginScreen(currentAccount) : null;
    guildDataMap.clear(); res.data.forEach(s => guildDataMap.set(s.id, s));
    if (guildFolders.length > 0) renderFolders(); 
    else {
        const l = document.getElementById('guild-list'); l.innerHTML = '';
        res.data.forEach(s => l.appendChild(createServerIconElement(s)));
    }
}

function createServerIconElement(s) {
    let el = document.createElement('div'); 
    el.id = `guild-${s.id}`; 
    el.className = 'server-icon group';
    el.title = s.name;
    el.onclick = () => loadChannels(s, el);
    
    if (s.icon) el.innerHTML = `<img src="https://cdn.discordapp.com/icons/${s.id}/${s.icon}.png?size=128" class="object-cover w-full h-full transition-all group-hover:rounded-2xl rounded-[24px]">`;
    else el.innerHTML = `<div class="w-full h-full flex items-center justify-center bg-gray-700 text-white font-bold text-sm transition-all group-hover:rounded-2xl rounded-[24px]">${s.name.substring(0, 2)}</div>`;
    return el;
}

function renderFolders() {
    const l = document.getElementById('guild-list'); l.innerHTML = '';
    guildFolders.forEach(item => {
        if (!item.guild_ids || item.guild_ids.length === 0) return;
        
        if (item.id) { // It is a folder
            const folderWrap = document.createElement('div');
            folderWrap.className = 'server-folder-wrapper';
            folderWrap.id = `folder-${item.id}`;

            // Actual contained guilds
            const containedGuilds = item.guild_ids.map(id => guildDataMap.get(id)).filter(Boolean);
            if (containedGuilds.length === 0) return;

            // Header Icon (The Folder Itself)
            const header = document.createElement('div');
            header.className = 'folder-closed group'; // default state

            // Create Mini Grid for Closed State
            const createMiniGrid = () => {
                header.innerHTML = '';
                containedGuilds.slice(0, 4).forEach(g => {
                    const img = document.createElement('img');
                    img.className = 'folder-icon-thumb';
                    img.src = g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/0.png`;
                    header.appendChild(img);
                });
            }
            createMiniGrid();

            // Background color for folder
            let folderColor = 'rgba(88, 101, 242, 0.4)';
            if (item.color) {
                const r = (item.color >> 16) & 255;
                const g = (item.color >> 8) & 255;
                const b = item.color & 255;
                folderColor = `rgba(${r},${g},${b},0.4)`;
            }
            header.style.backgroundColor = folderColor;

            // Content container (Initially Hidden)
            const contentDiv = document.createElement('div');
            contentDiv.className = 'hidden flex-col gap-2 items-center w-full transition-all';
            
            containedGuilds.forEach(g => contentDiv.appendChild(createServerIconElement(g)));

            // Click Handler
            header.onclick = () => {
                const isOpen = openFolderId === item.id;
                
                // Toggle Logic
                if (isOpen) {
                    // Close
                    openFolderId = null;
                    contentDiv.classList.add('hidden'); contentDiv.classList.remove('flex');
                    header.classList.remove('folder-opened'); header.classList.add('folder-closed');
                    header.style.backgroundColor = folderColor;
                    createMiniGrid();
                } else {
                    // Open
                    // First close other open folders if needed (optional)
                    if (openFolderId) document.querySelector(`#folder-${openFolderId} .folder-opened`)?.click();

                    openFolderId = item.id;
                    contentDiv.classList.remove('hidden'); contentDiv.classList.add('flex');
                    header.classList.remove('folder-closed'); header.classList.add('folder-opened');
                    // "Folder icon becomes a folder icon"
                    header.innerHTML = `<div class="folder-open-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M20 7H12L10 5H4C2.9 5 2.01 5.9 2.01 7L2 19C2 20.1 2.9 21 4 21H20C21.1 21 22 20.1 22 19V9C22 7.9 21.1 7 20 7Z"/></svg></div>`;
                    header.style.backgroundColor = 'rgba(88, 101, 242, 0.15)'; // Blue tint open state
                }
            };

            folderWrap.appendChild(header);
            folderWrap.appendChild(contentDiv);
            l.appendChild(folderWrap);

        } else {
            // Loose server (not in folder)
            item.guild_ids.forEach(gid => {
                const s = guildDataMap.get(gid);
                if (s) l.appendChild(createServerIconElement(s));
            });
        }
    });
}

// ---------------- CHANNELS & MESSAGES ----------------
async function loadChannels(g, t) {
    if (!currentAccount) return;
    document.querySelectorAll('.server-icon.active').forEach(e => e.classList.remove('active')); if (t) t.classList.add('active');
    document.getElementById('guild-name').innerText = g.name;
    const res = await apiRequest(currentAccount.token, `/guilds/${g.id}/channels`);
    if (res.error) return;
    const l = document.getElementById('channel-list'); l.innerHTML = '';
    const channels = res.data;
    const p = channels.reduce((a, ch) => { (a[ch.parent_id || 'null'] = a[ch.parent_id || 'null'] || []).push(ch); return a; }, {});
    Object.values(p).forEach(a => a.sort((x, y) => x.position - y.position));
    const render = ch => {
        if (![0, 5, 2].includes(ch.type)) return;
        const d = document.createElement('div'); d.id = `channel-${ch.id}`; d.className = 'channel-item p-1.5 pl-3 rounded-md cursor-pointer mb-0.5 text-[0.95em] truncate flex items-center relative'; 
        const icon = ch.type === 2 ? '<svg class="w-5 h-5 mr-1.5 opacity-60" fill="currentColor" viewBox="0 0 24 24"><path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77zm-4 0a8.977 8.977 0 00-6.22 3.32l1.62 1.34C6.54 6.78 7.68 6 9 6c2.37 0 4.54 1.05 5.96 2.7l1.7-1.39A8.932 8.932 0 0010 3.23zM5.16 8.78L2.73 11.2a8.96 8.96 0 000 3.19l2.43 2.43 1.54-1.54-.78-.79c-.28-.56-.45-1.19-.45-1.87s.17-1.3.45-1.86l.78-.78-1.54-1.54z"></path></svg>' : '<span class="text-xl mr-2 text-[var(--text-secondary)] opacity-70">#</span>';
        d.innerHTML = `${icon}<span class="${ch.type===2?'':'font-medium'}">${ch.name}</span>`;
        if (ch.type !== 2) d.onclick = () => selectChannel(ch); else d.classList.add('opacity-50', 'cursor-not-allowed'); 
        l.appendChild(d);
    };
    (p['null'] || []).forEach(render);
    channels.filter(i => i.type === 4).sort((x, y) => x.position - y.position).forEach(cat => {
        const h = document.createElement('div'); h.className = 'px-2 pt-4 pb-1 text-xs font-bold uppercase text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer flex items-center'; 
        h.innerHTML = `<svg class="w-3 h-3 mr-1 transition-transform transform expanded" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg> ${cat.name}`;
        l.appendChild(h); (p[cat.id] || []).forEach(render);
    });
    updatePingDots();
}

async function selectChannel(ch) {
    currentChannel = ch; oldestMessageId = null; isLoadingMore = false;
    cancelReply(); cancelAttachment(); delete pingCounts[ch.id]; updatePingDots();
    
    // Switch Views
    document.querySelectorAll('.channel-item.active').forEach(e => e.classList.remove('active'));
    const cE = document.getElementById(`channel-${ch.id}`); if (cE) cE.classList.add('active');
    if (window.innerWidth < 768) showChatView();

    let name = ch.name || ch.recipients?.[0]?.global_name || 'DM';
    document.getElementById('channel-name-text').innerHTML = `<span class="text-[var(--text-secondary)] opacity-70 mr-1.5">#</span><span>${name}</span>`;
    
    const con = document.getElementById('message-container'); con.innerHTML = '<div class="w-full h-full flex items-center justify-center"><div class="loader"></div></div>';
    
    if (ch.guild_id) checkTimeoutStatus(ch.guild_id); else setInputState(true);
    
    const res = await apiRequest(currentAccount.token, `/channels/${ch.id}/messages?limit=50`);
    con.innerHTML = '';
    
    if (res.error) {
        if (res.status === 401) showLoginScreen(currentAccount);
        return con.innerHTML = `<div class="p-8 text-center text-red-500 font-bold">アクセス権限がありません<br><span class="text-sm font-normal text-[var(--text-secondary)]">${res.error.message}</span></div>`;
    }

    const msgs = res.data;
    if (msgs.length > 0) {
        oldestMessageId = msgs[msgs.length - 1].id;
        const fragment = document.createDocumentFragment();
        let previousAuthId = null;
        // Logic for group starts from top(older) to bottom(newer) in reverse loop
        msgs.slice().reverse().forEach(m => {
            if (plugins.messageLogger) messageStore[m.id] = m;
            const el = createMessageElement(m, shouldGroup(m, previousAuthId));
            fragment.appendChild(el);
            previousAuthId = m.author.id;
        });
        con.appendChild(fragment);
        con.scrollTop = con.scrollHeight;
    }
}

function shouldGroup(curr, prevAuthId) {
    // If webhook, never group visually to avoid "everyone is same person" issue unless needed
    if (curr.webhook_id) return false;
    // Check type
    if (curr.type !== 0 && curr.type !== 19) return false;
    // Same author check
    return (curr.author.id === prevAuthId);
}

function createMessageElement(m, isGrouped) {
    let contentHtml = parseMarkdown(m.content);
    if (m.mentions) m.mentions.forEach(u => { contentHtml = contentHtml.replace(new RegExp(`<@!?${u.id}>`, 'g'), `<span class="mention">@${u.global_name || u.username}</span>`); });
    if (m.sticker_items) contentHtml += m.sticker_items.map(s=>`<img src="https://media.discordapp.net/stickers/${s.id}.webp?size=160" class="w-32 h-32 mt-2 block"/>`).join('');
    
    // Attachments
    if (m.attachments?.length > 0) {
        m.attachments.forEach(a => {
            const isImg = a.content_type?.startsWith('image/');
            const isVid = a.content_type?.startsWith('video/');
            if(isImg) contentHtml += `<a href="${a.url}" target="_blank" class="block mt-1"><img src="${a.url}" class="max-w-[300px] max-h-[300px] rounded-lg bg-[var(--bg-tertiary)] object-contain"></a>`;
            else if(isVid) contentHtml += `<video src="${a.url}" controls class="max-w-[300px] mt-2 rounded-lg bg-black block"></video>`;
            else contentHtml += `<div class="mt-2 p-3 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] flex items-center"><a href="${a.url}" target="_blank" class="text-[var(--text-link)] font-mono text-sm">${a.filename}</a></div>`;
        });
    }

    // Embeds
    if (m.embeds?.length > 0) contentHtml += m.embeds.map(renderEmbed).join('');

    const el = document.createElement('div'); 
    el.id = `message-${m.id}`; 
    el.className = "message-group relative px-4 pr-12 hover:bg-[var(--message-hover)] flex flex-col";
    if (!isGrouped) el.classList.add('mt-[1.0625rem]'); // Margin top for new groups

    // Interaction handlers
    if (plugins.clickAction) el.addEventListener('dblclick', () => startReply(m));

    // Optimistic / Failed State
    if (m.isSending) el.classList.add('message-sending');
    if (m.isFailed) el.classList.add('message-failed');

    // Toolbar
    const isMe = m.author.id === currentAccount.id;
    const del = isMe ? `<button onclick="deleteMessage('${m.id}', event)" class="p-1 hover:bg-[var(--bg-primary)] rounded text-red-500 hover:text-red-600 transition-colors"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>` : '';
    const edit = isMe ? `<button onclick="startEdit('${m.id}')" class="p-1 hover:bg-[var(--bg-primary)] rounded text-[var(--text-secondary)] transition-colors"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>` : '';
    const tb = `<div class="message-toolbar absolute -top-4 right-4 rounded shadow-sm bg-[var(--bg-secondary)] flex items-center p-0.5 z-10">${edit}${del}<button onclick='startReply(${JSON.stringify({id:m.id, author:m.author})})' class="p-1 hover:bg-[var(--bg-primary)] rounded text-[var(--text-secondary)]"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg></button></div>`;

    // Reference
    let refHtml = '';
    if (m.referenced_message && !isGrouped) {
        const rm = m.referenced_message;
        refHtml = `<div class="flex items-center gap-1 ml-[52px] mb-1 opacity-70 text-sm cursor-pointer hover:opacity-100" onclick="scrollToMessage('${rm.id}')"><div class="reply-spine"></div><img src="${rm.author.avatar ? `https://cdn.discordapp.com/avatars/${rm.author.id}/${rm.author.avatar}.png?size=16` : 'https://cdn.discordapp.com/embed/avatars/0.png'}" class="w-4 h-4 rounded-full"> <span class="font-bold mr-1 text-[var(--text-primary)] whitespace-nowrap overflow-hidden">${rm.author.global_name || rm.author.username}</span> <span class="text-[var(--text-secondary)] truncate">${rm.content || '添付ファイル'}</span></div>`;
    }

    // Logger
    let headerAddon = '';
    if (m.deleted && plugins.messageLogger) {
        el.classList.add('deleted-log');
        headerAddon += '<span class="deleted-log-tag">[DELETED]</span>';
    }

    if (isGrouped) {
        el.innerHTML = `${tb} <div class="ml-[56px] message-content-text">${contentHtml}</div>`;
    } else {
        const member = m.member || {}; 
        const name = member.nick || m.author.global_name || m.author.username;
        const color = member.color ? `#${member.color.toString(16).padStart(6,'0')}` : '';
        const avUrl = member.avatar ? `https://cdn.discordapp.com/guilds/${currentChannel.guild_id}/users/${m.author.id}/avatars/${member.avatar}.png?size=64` : (m.author.avatar ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${m.author.discriminator%5}.png`);
        
        let decoHtml = '';
        if (m.author.avatar_decoration_data) { 
             const decoUrl = `https://cdn.discordapp.com/avatar-decoration-presets/${m.author.avatar_decoration_data.asset}.png?size=96`; 
             decoHtml = `<img src="${decoUrl}" class="avatar-decoration">`; 
        }

        const date = new Date(m.timestamp);
        const timeStr = plugins.sendSeconds ? date.toLocaleTimeString() : date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        
        const usernameDisp = plugins.showMeYourName ? `<span class="ml-1 text-[0.8em] font-medium text-[var(--text-secondary)] opacity-70">@${m.author.username}</span>` : '';
        const botTag = m.author.bot ? `<span class="ml-1.5 bg-[#5865F2] text-white text-[0.625rem] px-1.5 rounded-[0.1875rem] py-[1px] font-medium align-middle">BOT</span>` : '';

        el.innerHTML = `${refHtml}${tb} <div class="flex mt-0.5"> <div class="avatar-container mr-4 cursor-pointer active:translate-y-[1px]"><img src="${avUrl}" class="avatar-img shadow-sm hover:shadow-md transition-shadow">${decoHtml}</div> <div class="flex-1 min-w-0"> <div class="flex items-center leading-[1.375rem]"> ${headerAddon} <span class="font-medium mr-1 cursor-pointer hover:underline" style="color:${color}">${name}</span> ${usernameDisp}${botTag} <span class="ml-2 text-[0.75rem] text-[var(--text-secondary)] cursor-default">${timeStr}</span> </div> <div class="message-content-text whitespace-pre-wrap leading-[1.375rem]">${contentHtml}</div> </div> </div>`;
    }

    // Check for history
    const h = editedMessages[m.id];
    if (plugins.messageLogger && h) {
        const textEl = el.querySelector('.message-content-text');
        textEl.innerHTML = `<span class="edited-old" title="Edited">${h}</span>${textEl.innerHTML}`;
    }
    
    // Check normal edited status
    if (m.edited_timestamp) {
         el.querySelector('.message-content-text').insertAdjacentHTML('beforeend', '<span class="text-[0.625rem] text-[var(--text-secondary)] ml-1 opacity-60 cursor-default select-none">(edited)</span>');
    }

    el.querySelector('.message-content-text').dataset.originalContent = m.content; 
    return el;
}

// ---------------- SEND & ACTION ----------------
async function sendMessage() {
    if (!currentChannel || !currentAccount) return;
    const input = document.getElementById('message-input');
    const content = input.value.trim();
    if (!content && !attachedFile) return;

    // OPTIMISTIC UI: Create a temporary fake message
    const tempId = `temp-${Date.now()}`;
    const fakeMsg = {
        id: tempId,
        author: currentAccount, // Basic user object is enough for now
        content: content,
        timestamp: new Date().toISOString(),
        isSending: true, // Marker for grey opacity
        attachments: [], 
        embeds: []
    };
    if (attachedFile) fakeMsg.attachments.push({ filename: attachedFile.name, url: '#' });

    renderMsg(fakeMsg); // Immediately render

    // Clear input
    input.value = '';
    input.style.height = 'auto';
    document.getElementById('send-button').disabled = true;

    try {
        let body;
        let isForm = false;
        
        if (attachedFile) {
            body = new FormData();
            body.append('payload_json', JSON.stringify({
                 content: content,
                 message_reference: replyingTo ? { message_id: replyingTo.messageId } : undefined
            }));
            body.append('files[0]', attachedFile);
            isForm = true;
        } else {
            body = {
                content: content,
                message_reference: replyingTo ? { message_id: replyingTo.messageId } : undefined
            };
        }

        const res = await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages`, 'POST', body, isForm);
        
        if (!res.error) {
            cancelAttachment(); cancelReply();
        } else {
            // Failed State
            const el = document.getElementById(`message-${tempId}`);
            if (el) {
                el.classList.remove('message-sending');
                el.classList.add('message-failed');
                el.querySelector('.message-content-text').insertAdjacentHTML('afterend', '<div class="text-xs text-red-500 font-bold mt-1">送信失敗 - 再読み込みしてください</div>');
            }
        }
    } catch (e) {
         renderClydeError('通信エラー');
    }
}

function renderMsg(m, options={}) {
    // When real WS event comes for our own message, remove the optimistic one
    // But since Discord returns different ID, we normally rely on `nonce` to match. 
    // Here simplified: WS will just append, and we remove temp. 
    // Ideally use nonce. For this Lite version, let WS event naturally display new message.
    // If we were fully syncing: remove temp element here if m.nonce matches.
    const container = document.getElementById('message-container');
    
    // Append or Prepend logic...
    const lastEl = document.querySelector('.message-group:last-child:not(.message-sending)'); 
    let isGrouped = false;

    // Very naive grouping logic for the live render
    if (lastEl && !options.isNew && !m.referenced_message) { 
        const lastId = lastEl.dataset.authorId; // Need to attach dataset in create
        if (lastId === m.author.id && !m.webhook_id) isGrouped = true; 
    }
    
    // create element
    const el = createMessageElement(m, isGrouped);
    // Add dataset for future check
    el.dataset.authorId = m.author.id;
    
    // Replace logic if nonce exists and we find temp (advanced) - skipped for brevity
    // Simple Append:
    if (options.isPrepended) container.prepend(el); 
    else container.appendChild(el); 
    
    if (options.isNew) container.scrollTop = container.scrollHeight;
}


// ---------------- UTILS & EVENTS ----------------

function handleInput() {
    const i = document.getElementById('message-input');
    const s = document.getElementById('send-button');
    i.style.height = 'auto'; i.style.height = (i.scrollHeight) + 'px';
    // Max length check visual ?
    s.disabled = (i.value.trim() === '' && !attachedFile);
}

// Websocket Handling
function connectWS() { 
    if (!currentAccount) return; 
    ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json'); 
    ws.onmessage = e => { 
        const d = JSON.parse(e.data); 
        if (d.s) lastSequence = d.s; 
        if (d.op === 10) { 
            heartbeatInterval = setInterval(()=>ws.send(JSON.stringify({op: 1, d: lastSequence})), d.d.heartbeat_interval); 
            ws.send(JSON.stringify({ op: 2, d: { token: currentAccount.token, properties: { $os: "linux", $browser: "disco", $device: "disco" } } })); 
        } else if (d.t === 'READY') {
             if (d.d.user_settings?.guild_folders) { guildFolders = d.d.user_settings.guild_folders; renderFolders(); }
        } else if (d.t === 'MESSAGE_CREATE') {
             if (d.d.channel_id === currentChannel?.id) { 
                if (d.d.author.id === currentAccount.id) {
                     // Cleanup sending visual (Remove any .message-sending elements that look like this? naive approach: remove all sending)
                     document.querySelectorAll('.message-sending').forEach(e => e.remove());
                }
                renderMsg(d.d, { isNew: true }); 
             }
        } else if (d.t === 'MESSAGE_UPDATE') {
             // Logger Logic
             if (plugins.messageLogger && d.d.id) {
                 // Try to find old message in memory
                 const old = messageStore[d.d.id];
                 if (old && d.d.content && old.content !== d.d.content) {
                     editedMessages[d.d.id] = old.content;
                     // re-render the element if visible
                     const el = document.getElementById(`message-${d.d.id}`);
                     if (el) {
                         const combined = { ...old, ...d.d }; // merge
                         el.outerHTML = createMessageElement(combined, el.innerHTML.includes('avatar-container') ? false : true).outerHTML;
                         messageStore[d.d.id] = combined; // update store
                     }
                 }
             }
        } else if (d.t === 'MESSAGE_DELETE') {
             const el = document.getElementById(`message-${d.d.id}`);
             if (el) {
                 if (plugins.messageLogger) {
                     el.classList.add('deleted-log');
                     if (!el.querySelector('.deleted-log-tag')) {
                         const header = el.querySelector('.flex.items-center');
                         if (header) header.insertAdjacentHTML('afterbegin', '<span class="deleted-log-tag">[DELETED]</span>');
                     }
                 } else {
                     el.remove();
                 }
             }
        }
    };
    ws.onclose = () => setTimeout(connectWS, 5000); 
}

// Settings
function renderSettingsModal() {
    const list = document.getElementById('plugin-list'); list.innerHTML = '';
    const defs = [
        { key: 'clickAction', name: 'Double Click Action', desc: 'メッセージをダブルクリックして返信します' },
        { key: 'showMeYourName', name: 'Show Me Your Name', desc: 'ユーザー名の横に(@username)を表示' },
        { key: 'sendSeconds', name: 'SendSeconds', desc: '送信時刻の秒数まで表示' },
        { key: 'messageLogger', name: 'MessageLogger', desc: '削除/編集されたメッセージをローカルに保存して表示' }
    ];
    defs.forEach(p => {
        const item = document.createElement('div');
        item.className = "flex items-center justify-between p-4 bg-[var(--bg-secondary)] rounded-lg border shadow-sm";
        item.style.borderColor = "var(--border-color)";
        item.innerHTML = `<div><div class="font-bold text-[var(--text-primary)]">${p.name}</div><div class="text-xs text-[var(--text-secondary)] mt-1">${p.desc}</div></div>
        <label class="switch"><input type="checkbox" ${plugins[p.key]?'checked':''} data-key="${p.key}"><span class="slider"></span></label>`;
        item.querySelector('input').onchange = (e) => {
            plugins[p.key] = e.target.checked;
            localStorage.setItem('plugins', JSON.stringify(plugins));
            // Reload View if needed
            if(currentChannel) selectChannel(currentChannel);
        }
        list.appendChild(item);
    });
    document.getElementById('settings-modal').classList.remove('hidden');
}

// Helper Wrappers
function startReply(m) { replyingTo = { messageId: m.id, author: m.author }; document.getElementById('reply-bar').classList.remove('hidden'); document.getElementById('reply-username').innerText = m.author.global_name || m.author.username; document.getElementById('message-input').focus(); }
function cancelReply() { replyingTo = null; document.getElementById('reply-bar').classList.add('hidden'); }
async function deleteMessage(id, e) {
    if (e.shiftKey || confirm("メッセージを削除しますか？")) { await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages/${id}`, 'DELETE'); }
}
function startEdit(id) { /* Basic impl */ const msgEl = document.getElementById(`message-${id}`); if (!msgEl) return; const contentEl = msgEl.querySelector('.message-content-text'); if (!contentEl) return; const original = contentEl.dataset.originalContent; contentEl.innerHTML = `<textarea class="input-field w-full p-2 bg-[var(--bg-tertiary)] rounded outline-none h-auto" rows="3">${original}</textarea><div class="text-xs mt-1">エンターで保存</div>`; const t = contentEl.querySelector('textarea'); t.onkeydown = async (e)=>{ if(e.key === 'Enter' && !e.shiftKey) { await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages/${id}`, 'PATCH', {content: t.value}); selectChannel(currentChannel); } } }

// Common logic
function renderEmbed(embed) { return `<div style="border-left:4px solid ${embed.color ? '#' + embed.color.toString(16).padStart(6,'0') : '#ccc'};" class="bg-[var(--bg-tertiary)] p-3 rounded mt-1 max-w-xl text-sm">${embed.title ? `<b>${embed.title}</b><br>` : ''}${embed.description||''}</div>`; }
function renderClydeError(t) { const c = document.getElementById('message-container'); c.insertAdjacentHTML('beforeend', `<div class="p-2 text-red-500 font-bold bg-[var(--error-bg)] rounded my-2 border-l-4 border-red-500">System: ${t}</div>`); c.scrollTop = c.scrollHeight; }
function parseMarkdown(t) { if(!t)return''; return t.replace(/</g,'&lt;').replace(/\n/g,'<br>').replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" class="text-[var(--text-link)] hover:underline">$1</a>'); } // Minimal parser
function updatePingDots() { document.querySelectorAll('.ping-dot').forEach(e=>e.remove()); /* Ping logic omitted for brevity but structures remain */ }
function checkTimeoutStatus(gid) { setInputState(true); /* Implement real checks here */ }
function setInputState(e) { document.getElementById('message-input').disabled = !e; document.getElementById('send-button').disabled = !e; }
function handleResize() { if(window.innerWidth>=768){showChatView();document.getElementById('sidebar-view').classList.remove('hidden');}else if(currentChannel)showChatView();else showSidebarView(); }
function showSidebarView() { document.getElementById('sidebar-view').classList.remove('hidden'); document.getElementById('chat-section').classList.add('hidden'); }
function showChatView() { document.getElementById('sidebar-view').classList.add('hidden'); document.getElementById('chat-section').classList.remove('hidden'); document.getElementById('chat-section').classList.add('flex'); }

document.addEventListener('DOMContentLoaded', async () => {
    // テーマ適用
    if (localStorage.theme === 'dark' || (!localStorage.theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
    
    // 安全に要素を取得してイベントを設定する関数
    const setEvent = (id, event, func) => {
        const el = document.getElementById(id);
        if (el) el[event] = func;
    };

    // 安全にイベント設定（エラーが出ないように修正）
    setEvent('theme-toggle-btn', 'onclick', () => { document.documentElement.classList.toggle('dark'); localStorage.theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'; });
    setEvent('send-button', 'onclick', sendMessage);
    setEvent('attach-button', 'onclick', () => document.getElementById('file-input').click());
    setEvent('cancel-attachment-btn', 'onclick', () => { attachedFile = null; document.getElementById('attachment-preview-bar').classList.add('hidden'); handleInput(); });
    setEvent('cancel-reply-btn', 'onclick', cancelReply);
    setEvent('back-to-channels-btn', 'onclick', showSidebarView);
    setEvent('add-account-button', 'onclick', () => addAccount(document.getElementById('token-input').value));
    setEvent('show-add-account-form-btn', 'onclick', () => showTokenInput(null));
    setEvent('back-to-accounts-btn', 'onclick', () => showLoginScreen());
    setEvent('dm-icon', 'onclick', e => loadDms(e.currentTarget));

    // アカウントスイッチャー系（HTML更新漏れでよくエラーになる箇所）
    setEvent('add-account-switcher-btn', 'onclick', () => { document.getElementById('account-switcher').classList.add('hidden'); showTokenInput(null); });
    
    // input系は特別扱い
    const fileInput = document.getElementById('file-input');
    if (fileInput) fileInput.onchange = e => { if (e.target.files[0]) { attachedFile = e.target.files[0]; document.getElementById('attachment-preview-bar').classList.remove('hidden'); document.getElementById('attachment-preview-name').innerText = attachedFile.name; handleInput(); }};
    
    const msgInput = document.getElementById('message-input');
    if (msgInput) {
        msgInput.oninput = handleInput;
        msgInput.onkeypress = e => { if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }};
    }
    
    const msgContainer = document.getElementById('message-container');
    if (msgContainer) {
        msgContainer.addEventListener('scroll', e => { if (e.target.scrollTop < 100 && oldestMessageId) loadMoreMessages() });
    }

    // Settings Modal
    window.addEventListener('resize', handleResize);
    document.addEventListener('click', (e) => { 
        if (!e.target.closest('#popup-picker') && !e.target.closest('#message-input')) document.getElementById('popup-picker')?.classList.add('hidden'); 
        if (!e.target.closest('#account-switcher') && !e.target.closest('#user-info-panel')) document.getElementById('account-switcher')?.classList.add('hidden');
    });

    // 起動処理
    await migrateOldData(); 
    const ac = getAccounts();
    const act = getActiveAccountId();
    if(ac.length>0 && act) switchAccount(act); else showLoginScreen();
});
