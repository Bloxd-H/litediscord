const API_BASE = 'https://discord.com/api/v10';
let ws, currentAccount, currentChannel, lastSequence, heartbeatInterval, timeoutInterval;
let lastMessageInfo = { authorId: null, timestamp: null };
let replyingTo = null;
let oldestMessageId = null;
let pingCounts = {};
let isLoadingMore = false;
let attachedFile = null;
let commandDebounce = null;
let memberDebounce = null;
let maxCharCount = 2000;
let guildFolders = []; // For storing official folder structure
let guildDataMap = new Map(); // Store API data for efficient access

// Plugins
const plugins = JSON.parse(localStorage.getItem('plugins')) || {
    showMeYourName: false,
    sendSeconds: false,
    messageLogger: false
};
let messageStore = {}; 

const sunIcon = `<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>`;
const moonIcon = `<svg class="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"></path></svg>`;

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
    cancelReply(); cancelAttachment();
}

async function apiRequest(token, path, method = 'GET', body = null, isFormData = false) {
    const o = { method, headers: { 'Authorization': token, 'X-Super-Properties': generateSuperProperties() } };
    if (body) {
        if (isFormData) { o.body = body } else { o.body = JSON.stringify(body); o.headers['Content-Type'] = 'application/json'; }
    }
    try {
        const r = await fetch(`${API_BASE}${path}`, o);
        if (r.status === 401) { return { error: { message: "Unauthorized" }, status: 401 }; }
        const data = r.status === 204 ? {} : await r.json();
        if (!r.ok) { return { error: data, status: r.status }; }
        return { data, status: r.status };
    } catch (e) {
        console.error("API Request Failed:", e);
        return { error: { message: "Network error" }, status: 0 };
    }
}

async function migrateOldData() {
    const oldToken = localStorage.getItem('token');
    const oldTokensMap = localStorage.getItem('tokens');
    let tokensToMigrate = [];
    if (oldToken && oldToken.trim().length > 0) tokensToMigrate.push(oldToken.replace(/^"|"$/g, ''));
    if (oldTokensMap) {
        try { const parsed = JSON.parse(oldTokensMap); Object.values(parsed).forEach(t => tokensToMigrate.push(t.replace(/^"|"$/g, ''))); } catch(e) {}
    }
    tokensToMigrate = [...new Set(tokensToMigrate)];
    if (tokensToMigrate.length === 0) return false;

    updateView('auth');
    document.getElementById('migration-view').classList.remove('hidden');
    document.getElementById('migration-view').classList.add('flex');

    let accounts = getAccounts();
    let migratedCount = 0;
    for (const t of tokensToMigrate) {
        if (accounts.some(a => a.token === t)) continue;
        const res = await apiRequest(t, '/users/@me');
        if (res.data && res.data.id) { accounts.push({ ...res.data, token: t }); migratedCount++; }
    }
    if (migratedCount > 0) { saveAccounts(accounts); localStorage.removeItem('token'); localStorage.removeItem('tokens'); }
    document.getElementById('migration-view').classList.add('hidden');
    document.getElementById('migration-view').classList.remove('flex');
    return migratedCount > 0;
}

// ----------------------------------------------------
// Missing Logic Fixes (Fixes: updateView is not defined)
// ----------------------------------------------------

function updateView(viewName) {
    const authSection = document.getElementById('auth-section');
    const mainApp = document.getElementById('main-app');

    if (viewName === 'auth') {
        authSection.classList.remove('hidden');
        authSection.classList.add('flex');
        mainApp.classList.add('hidden');
        mainApp.classList.remove('flex');
    } else if (viewName === 'app') {
        authSection.classList.add('hidden');
        authSection.classList.remove('flex');
        mainApp.classList.remove('hidden');
        mainApp.classList.add('flex');
        if (window.innerWidth < 768) {
            showSidebarView();
        }
    }
}

function showLoginScreen(reloginAccount = null) {
    cleanupState();
    updateView('auth');
    document.getElementById('migration-view').classList.add('hidden');
    document.getElementById('token-input-view').classList.add('hidden');
    
    // アカウント一覧の生成
    renderSavedAccountsList();

    const accounts = getAccounts();
    // 保存済みアカウントがあり、かつ強制再ログインモードでなければリスト表示
    if (accounts.length > 0 && !reloginAccount) {
        document.getElementById('account-selection-view').classList.remove('hidden');
        document.getElementById('account-selection-view').classList.add('flex');
        document.getElementById('token-input-view').classList.remove('flex');
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
    const loginError = document.getElementById('login-error');
    if (loginError) loginError.innerText = '';

    const userInfo = document.getElementById('relogin-user-info');
    if (account) {
        // 再ログイン画面
        document.getElementById('auth-title').innerText = '再ログイン';
        userInfo.classList.remove('hidden');
        userInfo.classList.add('flex');
        
        document.getElementById('relogin-name').innerText = account.global_name || account.username;
        document.getElementById('relogin-username').innerText = account.username;
        const avatar = account.avatar ? `https://cdn.discordapp.com/avatars/${account.id}/${account.avatar}.png?size=128` : `https://cdn.discordapp.com/embed/avatars/${account.discriminator % 5}.png`;
        document.getElementById('relogin-avatar').src = avatar;
        
        document.getElementById('token-label').innerText = '新しいトークン';
        document.getElementById('add-account-button-text').innerText = 'アカウントを更新';
        // Add special data attribute to button to handle logic if needed
    } else {
        // 新規追加
        document.getElementById('auth-title').innerText = 'アカウントを追加';
        userInfo.classList.add('hidden');
        userInfo.classList.remove('flex');
        document.getElementById('token-label').innerText = 'トークン';
        document.getElementById('add-account-button-text').innerText = 'ログイン';
    }
}

function renderSavedAccountsList() {
    const list = document.getElementById('saved-accounts-list');
    const accounts = getAccounts();
    list.innerHTML = '';
    
    accounts.forEach(acc => {
        const div = document.createElement('div');
        div.className = "flex items-center gap-3 p-3 border rounded hover:bg-gray-100 dark:hover:bg-gray-600 cursor-pointer transition-colors";
        // Light styling override
        div.style.borderColor = 'var(--border-color)';
        
        const avatar = acc.avatar 
            ? `https://cdn.discordapp.com/avatars/${acc.id}/${acc.avatar}.png?size=64` 
            : `https://cdn.discordapp.com/embed/avatars/${acc.discriminator % 5}.png`;
            
        div.innerHTML = `
            <img src="${avatar}" class="w-10 h-10 rounded-full bg-gray-300">
            <div class="flex-1 min-w-0">
                <div class="font-bold truncate">${acc.global_name || acc.username}</div>
                <div class="text-xs text-[var(--text-secondary)] truncate">@${acc.username}</div>
            </div>
            <div class="delete-btn p-2 text-gray-400 hover:text-red-500 rounded-full" title="削除">
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clip-rule="evenodd"></path></svg>
            </div>
        `;
        
        div.onclick = (e) => {
            // Deleteボタンクリック時の除外処理
            if (e.target.closest('.delete-btn')) return;
            switchAccount(acc.id);
        };
        
        const deleteBtn = div.querySelector('.delete-btn');
        deleteBtn.onclick = (e) => deleteAccount(acc.id, e);
        
        list.appendChild(div);
    });
}

// Minimal implementation of potentially missing functions to prevent crash
async function sendMessage() {
    if (!currentChannel || !currentAccount) return;
    const input = document.getElementById('message-input');
    const content = input.value.trim();
    if (!content && !attachedFile) return;
    
    const sendBtn = document.getElementById('send-button');
    sendBtn.disabled = true;

    try {
        let body;
        let isForm = false;
        
        // Simple file attachment handling
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
            input.value = '';
            cancelAttachment();
            cancelReply();
            handleInput(); // reset height etc
        } else {
             renderClydeError(res.error.message || '送信に失敗しました');
        }
    } catch (e) {
        console.error(e);
        renderClydeError('エラーが発生しました');
    } finally {
        sendBtn.disabled = false;
    }
}

function renderPopup(items, type, offset = 0) {
    // Basic placeholder if omitted in original code
    const p = document.getElementById('popup-picker');
    p.innerHTML = '';
    if(!items || items.length === 0) {
        p.classList.add('hidden');
        return;
    }
    p.classList.remove('hidden');
    // Implement simple listing if needed
    // ...
}

function renderEmbed(embed) {
    // Simple placeholder to prevent crash in createMessageElement
    return `<div style="border-left:4px solid ${embed.color ? '#' + embed.color.toString(16) : '#ddd'}; padding:8px; margin:4px 0; background:var(--bg-tertiary); border-radius:4px;">
        ${embed.title ? `<b>${embed.title}</b><br>` : ''}
        ${embed.description || '(埋め込みコンテンツ)'}
    </div>`;
}

// ----------------------------------------------------

function handleSessionInvalid() { if (!currentAccount) return; cleanupState(); showLoginScreen(currentAccount); }

async function addAccount(token) {
    document.getElementById('login-error').innerText = "";
    if (!token || !token.trim()) return;
    token = token.trim().replace(/^"|"$/g, '');
    const b = document.getElementById('add-account-button'), t = document.getElementById('add-account-button-text'), s = document.getElementById('login-spinner');
    t.classList.add('hidden'); s.classList.remove('hidden'); b.disabled = true;
    const result = await apiRequest(token, '/users/@me');
    t.classList.remove('hidden'); s.classList.add('hidden'); b.disabled = false;
    if (result.data && result.data.id) {
        const a = getAccounts(); const i = a.findIndex(acc => acc.id === result.data.id); const n = { ...result.data, token };
        if (i > -1) { a[i] = n; } else { a.push(n); }
        saveAccounts(a); switchAccount(result.data.id);
    } else { document.getElementById('login-error').innerText = `エラー: ${result.error?.message || '無効なトークン'}`; }
}

function switchAccount(id) {
    // If updateView definition is missing in local scope, it will be found in the added functions above
    cleanupState(); setActiveAccountId(id);
    const a = getAccounts().find(a => a.id === id);
    if (!a) { showLoginScreen(); return }
    currentAccount = a;
    maxCharCount = (currentAccount.premium_type === 2) ? 4000 : 2000;
    document.getElementById('token-input').value = '';
    updateView('app'); 
    renderUserInfo(); renderAccountSwitcher(); loadGuilds();
    setTimeout(connectWS, 100); 
}

function deleteAccount(id, e) {
    if(e) e.stopPropagation(); if (!confirm("このアカウントを削除しますか？")) return;
    let a = getAccounts(); a = a.filter(acc => acc.id !== id); saveAccounts(a);
    if (getActiveAccountId() === id || !getActiveAccountId()) { localStorage.removeItem('activeAccountId'); showLoginScreen(); }
    else { renderSavedAccountsList(); renderAccountSwitcher(); }
}

function renderUserInfo() {
    if (!currentAccount) return;
    const p = document.getElementById('user-info-panel');
    const a = currentAccount.avatar ? `https://cdn.discordapp.com/avatars/${currentAccount.id}/${currentAccount.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${currentAccount.discriminator % 5}.png`;
    p.innerHTML = `<img src="${a}" class="w-10 h-10 rounded-full"><div class="flex-1 truncate"><b class="text-sm truncate">${currentAccount.global_name || currentAccount.username}</b><div class="text-xs opacity-60 truncate">@${currentAccount.username}</div></div>`;
}

function renderAccountSwitcher() {
    const l = document.getElementById('account-list'), a = getAccounts(), i = getActiveAccountId();
    l.innerHTML = a.map(acc => {
        const av = acc.avatar ? `https://cdn.discordapp.com/avatars/${acc.id}/${acc.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${acc.discriminator % 5}.png`;
        const isA = acc.id === i;
        return `<div class="flex items-center gap-2 p-2 rounded-md cursor-pointer hover:bg-gray-500/20" onclick="switchAccount('${acc.id}')"><img src="${av}" class="w-8 h-8 rounded-full"><span class="flex-1 truncate text-sm font-semibold">${acc.global_name || acc.username}</span> ${isA ? '<svg class="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>' : ''} <div onclick="deleteAccount('${acc.id}',event)" title="削除" class="p-1 rounded-full text-red-500 hover:bg-red-500/20"><svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"></path></svg></div></div>`;
    }).join('');
}

function renderSettingsModal() {
    const list = document.getElementById('plugin-list'); list.innerHTML = '';
    const pluginDefs = [
        { key: 'showMeYourName', name: 'ShowMeYourName', desc: '名前の横にユーザーネーム(@username)を表示します' },
        { key: 'sendSeconds', name: 'SendSeconds', desc: 'メッセージの送信時刻を秒まで表示します' },
        { key: 'messageLogger', name: 'MessageLogger', desc: '削除・編集されたメッセージをローカルに保存して表示します' }
    ];
    pluginDefs.forEach(p => {
        const row = document.createElement('div'); row.className = 'flex items-center justify-between p-3 bg-[var(--bg-primary)] rounded-lg';
        row.innerHTML = `<div><div class="font-bold">${p.name}</div><div class="text-xs opacity-70">${p.desc}</div></div><div class="relative inline-block w-10 mr-2 align-middle select-none"><input type="checkbox" id="toggle-${p.key}" class="toggle-checkbox absolute block w-6 h-6 rounded-full bg-white border-4 appearance-none cursor-pointer" ${plugins[p.key] ? 'checked' : ''}><label for="toggle-${p.key}" class="toggle-label block overflow-hidden h-6 rounded-full bg-gray-300 cursor-pointer"><span class="toggle-dot"></span></label></div>`;
        row.querySelector('input').onchange = (e) => { plugins[p.key] = e.target.checked; localStorage.setItem('plugins', JSON.stringify(plugins)); if (currentChannel) selectChannel(currentChannel); };
        list.appendChild(row);
    });
    document.getElementById('settings-modal').classList.remove('hidden');
}

async function loadGuilds() {
    if (!currentAccount) return;
    const res = await apiRequest(currentAccount.token, '/users/@me/guilds');
    if (res.error) { if (res.status === 401) handleSessionInvalid(); return; }
    
    // 保存（後で並び替えに使用）
    guildDataMap.clear();
    res.data.forEach(s => guildDataMap.set(s.id, s));

    // WSからのフォルダ情報がまだない場合は通常のリスト表示
    if(guildFolders.length === 0) {
        const l = document.getElementById('guild-list'); l.innerHTML = '';
        res.data.forEach(s => l.appendChild(createServerIconElement(s)));
    } else {
        renderServerListFromFolders(); 
    }
}

function createServerIconElement(s) {
    let el = document.createElement('div'); el.id = `guild-${s.id}`; el.className = 'server-icon cursor-pointer w-12 h-12 mb-1'; el.title = s.name; el.onclick = () => loadChannels(s, el);
    if (s.icon) { el.innerHTML = `<img src="https://cdn.discordapp.com/icons/${s.id}/${s.icon}.png?size=128" class="object-cover w-full h-full">`; }
    else { el.innerHTML = `<div class="w-full h-full flex items-center justify-center bg-gray-700 text-white font-bold text-sm">${s.name.replace(/[^\w\s]/gi, '').split(' ').map(w => w[0]).join('').substring(0, 2)}</div>`; }
    return el;
}

function renderServerListFromFolders() {
    const l = document.getElementById('guild-list'); 
    if(!l) return;
    l.innerHTML = '';

    guildFolders.forEach(item => {
        if (item.guild_ids && item.guild_ids.length > 0) {
            if (item.id) {
                // Folder
                const folderWrapper = document.createElement('div');
                folderWrapper.className = 'server-folder-wrapper';
                
                const validGuilds = item.guild_ids.map(id => guildDataMap.get(id)).filter(Boolean);
                if(validGuilds.length === 0) return;

                const folderIcon = document.createElement('div');
                folderIcon.className = 'folder-icon';
                if(item.color) {
                    const r = (item.color >> 16) & 255;
                    const g = (item.color >> 8) & 255;
                    const b = item.color & 255;
                    folderIcon.style.backgroundColor = `rgba(${r},${g},${b},0.4)`;
                }

                validGuilds.slice(0, 4).forEach(g => {
                    const thumb = document.createElement('img');
                    thumb.className = 'folder-icon-thumb';
                    thumb.src = g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/0.png`;
                    folderIcon.appendChild(thumb);
                });

                const itemsDiv = document.createElement('div');
                itemsDiv.className = 'server-folder';
                itemsDiv.style.display = 'none'; 
                validGuilds.forEach(g => itemsDiv.appendChild(createServerIconElement(g)));

                folderIcon.onclick = () => {
                    const isClosed = itemsDiv.style.display === 'none';
                    itemsDiv.style.display = isClosed ? 'flex' : 'none';
                };

                folderWrapper.appendChild(folderIcon);
                folderWrapper.appendChild(itemsDiv);
                l.appendChild(folderWrapper);

            } else {
                // Not in folder
                item.guild_ids.forEach(gid => {
                    const s = guildDataMap.get(gid);
                    if (s) l.appendChild(createServerIconElement(s));
                });
            }
        }
    });
}

async function loadChannels(g, t) {
    if (!currentAccount) return;
    document.querySelectorAll('.server-icon.active').forEach(e => e.classList.remove('active')); if (t) t.classList.add('active');
    document.getElementById('guild-name').innerText = g.name;
    const { data: c } = await apiRequest(currentAccount.token, `/guilds/${g.id}/channels`);
    if (!c || !Array.isArray(c)) return;
    const l = document.getElementById('channel-list'); l.innerHTML = '';
    const p = c.reduce((a, ch) => { (a[ch.parent_id || 'null'] = a[ch.parent_id || 'null'] || []).push(ch); return a; }, {});
    Object.values(p).forEach(a => a.sort((x, y) => x.position - y.position));
    const r = ch => {
        if (ch.type !== 0 && ch.type !== 5 && ch.type !== 2) return;
        const d = document.createElement('div'); d.id = `channel-${ch.id}`; d.className = 'channel-item p-2 rounded cursor-pointer mb-1 text-sm truncate'; d.innerHTML = `<span>${ch.type === 2 ? '🔊' : '#'} ${ch.name}</span>`;
        if (ch.type !== 2) d.onclick = () => selectChannel(ch); else d.classList.add('opacity-50', 'cursor-not-allowed'); l.appendChild(d);
    };
    (p['null'] || []).forEach(r);
    c.filter(i => i.type === 4).sort((x, y) => x.position - y.position).forEach(cat => {
        const h = document.createElement('div'); h.className = 'px-1 pt-4 pb-1 text-xs font-bold uppercase text-[var(--text-secondary)]'; h.innerText = cat.name; l.appendChild(h); (p[cat.id] || []).forEach(r);
    });
    updatePingDots();
}

async function loadDms(t) {
    if (!currentAccount) return;
    document.querySelectorAll('.server-icon.active').forEach(e => e.classList.remove('active')); if (t) t.classList.add('active');
    document.getElementById('guild-name').innerText = 'Direct Messages';
    const { data: d } = await apiRequest(currentAccount.token, '/users/@me/channels');
    if (!d || !Array.isArray(d)) return;
    const l = document.getElementById('channel-list'); l.innerHTML = '';
    d.sort((a, b) => (b.last_message_id || '0').localeCompare(a.last_message_id || '0')).forEach(dm => {
        const recipient = dm.recipients?.[0] || {};
        const name = dm.name || recipient.global_name || recipient.username || 'DM';
        const avatar = recipient.avatar ? `https://cdn.discordapp.com/avatars/${recipient.id}/${recipient.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${recipient.discriminator % 5}.png`;
        const el = document.createElement('div'); el.id = `channel-${dm.id}`; el.className = 'channel-item p-2 rounded cursor-pointer mb-1 text-sm truncate flex items-center gap-3';
        el.innerHTML = `<img src="${avatar}" class="w-8 h-8 rounded-full"> <span class="flex-1">${name}</span>`; el.onclick = () => selectChannel(dm); l.appendChild(el);
    });
    updatePingDots();
}

async function searchSlashCommands(query, channelId) {
    if (!channelId) return [];
    try {
        const q = query || ""; const url = `/channels/${channelId}/application-commands/search?type=1&query=${encodeURIComponent(q)}&limit=10`;
        const { data, error } = await apiRequest(currentAccount.token, url);
        if(error) return []; return data?.application_commands || [];
    } catch { return []; }
}

async function searchMembers(query, guildId) {
    if (!guildId) return []; if (!query || query.length < 1) return [];
    try {
        const { data, error } = await apiRequest(currentAccount.token, `/guilds/${guildId}/members/search?query=${encodeURIComponent(query)}&limit=10`);
        if (error) return []; return data || [];
    } catch { return []; }
}

// Helper: 現在表示されているメッセージリストの最後尾（仮を除く）のユーザーIDを取得
function getLastMessageAuthorId() {
    const con = document.getElementById('message-container');
    // メッセージかつ仮でない要素を後ろから探す
    const msgs = Array.from(con.querySelectorAll('.message-group:not(.message-sending)'));
    if (msgs.length === 0) return null;
    return msgs[msgs.length - 1]; // 要素を返す
}

async function selectChannel(ch) {
    currentChannel = ch; oldestMessageId = null; isLoadingMore = false;
    cancelReply(); cancelAttachment(); delete pingCounts[ch.id]; updatePingDots(); messageStore = {};
    document.querySelectorAll('.channel-item.active').forEach(e => e.classList.remove('active'));
    const cE = document.getElementById(`channel-${ch.id}`); if (cE) cE.classList.add('active');
    if (window.innerWidth < 768) showChatView();
    
    let name = ch.name || ch.recipients?.[0]?.global_name || ch.recipients?.[0]?.username || 'DM';
    document.getElementById('channel-name-text').innerHTML = `<span class="text-gray-500 mr-1">#</span><span>${name}</span>`;
    const con = document.getElementById('message-container'); con.innerHTML = '<div class="m-auto text-xs opacity-50">...</div>';
    if (ch.guild_id) checkTimeoutStatus(ch.guild_id); else setInputState(true);
    const res = await apiRequest(currentAccount.token, `/channels/${ch.id}/messages?limit=100`);
    con.innerHTML = '';
    if (res.error) { 
        con.innerHTML = `<div class="m-auto text-center p-4"><div class="text-red-500 font-bold mb-2">Error</div><div>${res.error.message}</div></div>`; 
        if(res.status === 401) handleSessionInvalid(); return; 
    }
    const ms = res.data;
    if (Array.isArray(ms) && ms.length > 0) {
        oldestMessageId = ms[ms.length - 1].id; const lastReadId = ms[0].id;
        // 一括描画の際もrenderMsgを通す
        ms.reverse().forEach(m => { 
            if (plugins.messageLogger) messageStore[m.id] = m; 
            renderMsg(m);
        });
        if ((con.scrollHeight - con.scrollTop - con.clientHeight) < 1) { await apiRequest(currentAccount.token, `/channels/${ch.id}/messages/${lastReadId}/ack`, 'POST', {}); }
        setTimeout(() => con.scrollTop = con.scrollHeight, 0);
    }
}

async function loadMoreMessages() {
    if (isLoadingMore || !oldestMessageId || !currentChannel) return; isLoadingMore = true;
    const con = document.getElementById('message-container'); const oldHeight = con.scrollHeight;
    const { data: messages } = await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages?limit=100&before=${oldestMessageId}`);
    if (Array.isArray(messages) && messages.length > 0) {
        oldestMessageId = messages[messages.length - 1].id;
        const fragment = document.createDocumentFragment(); messages.reverse();
        let lastBatchAuthId = null; // バッチ内での比較用
        messages.forEach(msg => {
            if (plugins.messageLogger) messageStore[msg.id] = msg;
            const isGrouped = (msg.author.id === lastBatchAuthId && !msg.referenced_message && !msg.webhook_id);
            const el = createMessageElement(msg, isGrouped);
            el.dataset.authorId = msg.author.id;
            el.dataset.timestamp = msg.timestamp;
            fragment.appendChild(el);
            lastBatchAuthId = msg.author.id;
        });
        con.prepend(fragment); con.scrollTop = con.scrollHeight - oldHeight;
    } else { oldestMessageId = null; } isLoadingMore = false;
}

function createMessageElement(m, isGrouped) {
    let contentHtml = parseMarkdown(m.content);
    if (m.mentions) m.mentions.forEach(u => { contentHtml = contentHtml.replace(new RegExp(`@${u.id}`, 'g'), `@${u.global_name || u.username}`); });
    if (m.sticker_items) contentHtml += m.sticker_items.map(s=>`<img src="https://media.discordapp.net/stickers/${s.id}.webp?size=160" alt="${s.name}" class="w-32 h-32 mt-2"/>`).join('');
    if (m.attachments?.length > 0) contentHtml += m.attachments.map(a=>{ if (a.content_type?.startsWith('image')) return `<br><a href="${a.url}" target="_blank"><img src="${a.url}" class="max-w-xs cursor-pointer rounded-lg mt-2" style="display: block;"/></a>`; if (a.content_type?.startsWith('video')) return `<br><video src="${a.url}" controls playsinline muted class="max-w-xs rounded-lg mt-2"></video>`; return `<div class="mt-2 p-3 rounded-md text-[var(--text-primary)]" style="background-color:var(--bg-tertiary);"><a href="${a.url}" target="_blank" class="text-[var(--text-link)]">${a.filename}</a></div>` }).join(''); 
    
    let replyPreviewHtml = '';
    if (m.referenced_message) {
        const rm = m.referenced_message, rAuth = rm.author, rAuthName = rAuth.global_name || rAuth.username;
        const rAuthAvatar = rAuth.avatar ? `https://cdn.discordapp.com/avatars/${rAuth.id}/${rAuth.avatar}.png?size=32` : `https://cdn.discordapp.com/embed/avatars/${rAuth.discriminator % 5}.png`;
        replyPreviewHtml = `<div class="flex items-center ml-14 mb-1 cursor-pointer opacity-60 hover:opacity-100" onclick="scrollToMessage('${rm.id}')"><div class="reply-spine"></div><img src="${rAuthAvatar}" class="w-4 h-4 rounded-full mr-2"><b class="mr-2 text-sm text-[var(--text-link)]">${rAuthName}</b><span class="truncate text-xs">${rm.content || 'Attachment'}</span></div>`;
    }
    if (m.embeds?.length > 0) contentHtml += m.embeds.map(renderEmbed).join('');
    
    const el = document.createElement('div'); el.id = `message-${m.id}`; el.className = "px-4 message-group relative hover:bg-[var(--message-hover)]";
    el.dataset.authorId = m.author.id;
    el.dataset.timestamp = m.timestamp;

    if (m.deleted) el.classList.add('deleted-log'); 
    const isAuthor = m.author.id === currentAccount.id;
    if (!isAuthor && (m.mentions?.some(u=>u.id===currentAccount.id) || m.mention_everyone)) el.classList.add('mention-highlight');
    const deleteAction = `deleteMessage("${m.id}", event)`;
    const toolbarHtml = `<div class="message-toolbar absolute -top-4 right-2 flex items-center gap-1 p-1 rounded-md shadow bg-[var(--bg-secondary)] text-[var(--text-secondary)] z-10"> <button onclick='startReply(${JSON.stringify({id: m.id, author: m.author})})' title="Reply" class="p-1 hover:bg-[var(--hover-bg)] rounded"><svg class="w-4 h-4" viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" fill="currentColor"/></svg></button> ${isAuthor ? `<button onclick='startEdit("${m.id}")' class="p-1 hover:bg-[var(--hover-bg)] rounded" title="Edit"><svg class="w-4 h-4" viewBox="0 0 20 20"><path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828zM2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clip-rule="evenodd" fill="currentColor"></path></svg></button> <button onclick='${deleteAction}' class="p-1 hover:bg-red-500/10 text-red-500 rounded" title="Delete (Shift to bypass)"><svg class="w-4 h-4" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clip-rule="evenodd" fill="currentColor"></path></svg></button>` : ''}</div>`;
    
    if (isGrouped) {
        el.innerHTML = `<div class="flex pl-[3.25rem] pt-0.5"><div class="text-sm break-words message-content-text w-full">${contentHtml}</div></div> ${toolbarHtml}`;
    } else {
        const member = m.member || {}; 
        const serverNick = member.nick || m.author.global_name || m.author.username;
        const usernameDisplay = plugins.showMeYourName ? ` <span class="text-xs opacity-60">(${m.author.username})</span>` : '';
        const botTag = m.author.bot ? `<span class="bg-blue-500 text-white text-[10px] px-1 rounded ml-1 align-middle">BOT</span>` : '';
        let avatarUrl = m.author.avatar ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${m.author.discriminator % 5}.png`;
        if (member.avatar) avatarUrl = `https://cdn.discordapp.com/guilds/${currentChannel.guild_id}/users/${m.author.id}/avatars/${member.avatar}.png?size=64`;
        let decoHtml = '';
        if (m.author.avatar_decoration_data) { const decoUrl = `https://cdn.discordapp.com/avatar-decoration-presets/${m.author.avatar_decoration_data.asset}.png?size=64`; decoHtml = `<img src="${decoUrl}" class="avatar-decoration">`; }
        const date = new Date(m.timestamp);
        const timeStr = plugins.sendSeconds ? date.toLocaleTimeString() : date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        el.innerHTML = `${replyPreviewHtml}<div class="relative flex gap-3 pt-1 mt-1"><div class="avatar-container"><img src="${avatarUrl}" class="avatar-img">${decoHtml}</div><div class="flex-1 min-w-0"><div class="flex items-center"><b class="text-sm hover:underline cursor-pointer mr-1">${serverNick}</b>${usernameDisplay}${botTag}<span class="text-xs opacity-40 ml-2">${timeStr}</span></div><div class="text-sm break-words message-content-text w-full">${contentHtml}</div></div></div> ${toolbarHtml}`;
    }
    if (m.edited_timestamp && plugins.messageLogger && m.old_content) {
         const contentEl = el.querySelector('.message-content-text'); contentEl.innerHTML = `<span class="edited-log">${m.old_content}</span>` + contentEl.innerHTML + '<span class="text-[10px] opacity-50 ml-1">(edited)</span>';
    } else if (m.edited_timestamp) el.querySelector('.message-content-text').insertAdjacentHTML('beforeend', '<span class="text-[10px] opacity-50 ml-1">(edited)</span>');
    el.querySelector('.message-content-text').dataset.originalContent = m.content; return el;
}

// メッセージ追加処理
function renderMsg(m, options={}) { 
    const { isNew = false, isPrepended = false } = options; 
    if (!m.author || !currentAccount) return; 
    const container = document.getElementById('message-container'); 
    
    let isGrouped = false;

    // リストへの追加(Append)の場合、表示済みの最後の要素とチェックする
    if (!isPrepended) {
        const lastEl = getLastMessageAuthorId(); // 実際に画面に出ている最後の要素(仮除く)を取得
        if (lastEl && !m.referenced_message && !m.webhook_id) { 
            const lastId = lastEl.dataset.authorId;
            const lastTs = new Date(lastEl.dataset.timestamp).getTime();
            const curTs = new Date(m.timestamp).getTime();
            
            // 同じ人 かつ 5分以内 ならグループ化
            if (lastId === m.author.id && (curTs - lastTs) < 300 * 1000) {
                isGrouped = true;
            }
        }
    }
    
    const el = createMessageElement(m, isGrouped); 
    if (isPrepended) container.prepend(el); 
    else container.appendChild(el); 
}

// WS Connect Logic
function connectWS() { 
    if (!currentAccount || !currentAccount.token) return; 
    if (ws) ws.close(); 
    ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json'); 
    ws.onmessage = e => { 
        const d = JSON.parse(e.data); 
        if (d.s) lastSequence = d.s; 
        if (d.op === 10) { 
            if (heartbeatInterval) clearInterval(heartbeatInterval); heartbeatInterval = setInterval(()=>ws.send(JSON.stringify({ op: 1, d: lastSequence })), d.d.heartbeat_interval); 
            ws.send(JSON.stringify({ op: 2, d: { token: currentAccount.token, properties: { $os: "windows", $browser: "chrome", $device: "" } } })); 
        } else if (d.t === 'READY') {
            if (d.d.user_settings && d.d.user_settings.guild_folders) {
                guildFolders = d.d.user_settings.guild_folders;
                renderServerListFromFolders(); 
            }
        } else if (d.t === 'MESSAGE_CREATE') { 
            if (d.d.channel_id === currentChannel?.id) { 
                if(plugins.messageLogger) messageStore[d.d.id] = d.d;
                if(d.d.nonce) { 
                    const temp = document.querySelector(`[id^=message-temp-${d.d.nonce}]`); 
                    if(temp) temp.remove(); 
                }
                renderMsg(d.d, { isNew: true }); 
                const con = document.getElementById('message-container');
                if ((con.scrollHeight - con.scrollTop - con.clientHeight) < 200) { con.scrollTop = con.scrollHeight; apiRequest(currentAccount.token, `/channels/${d.d.channel_id}/messages/${d.d.id}/ack`, 'POST', {}); }
            } 
            if (d.d.guild_id && (d.d.mentions?.some(u=>u.id === currentAccount.id) || d.d.mention_everyone)) updatePings(d.d.channel_id, 1, false, d.d.guild_id); 
            else if (!d.d.guild_id) updatePings(d.d.channel_id, 1, true); 
        } else if (d.t === 'MESSAGE_DELETE' && d.d.channel_id === currentChannel?.id) {
            const el = document.getElementById(`message-${d.d.id}`);
            if (el) { if (plugins.messageLogger) { el.classList.add('deleted-log'); if(!el.querySelector('.deleted-tag')) el.querySelector('.message-content-text').insertAdjacentHTML('afterbegin', '<span class="text-red-500 font-bold text-xs mr-1 deleted-tag">[DELETED]</span> '); } else { el.remove(); } }
        } else if (d.t === 'MESSAGE_UPDATE' && d.d.channel_id === currentChannel?.id) { 
            const el = document.getElementById(`message-${d.d.id}`); 
            if (el && d.d.content !== undefined) { 
                if (plugins.messageLogger && messageStore[d.d.id]) { const oldContent = messageStore[d.d.id].content; if(oldContent !== d.d.content) d.d.old_content = oldContent; messageStore[d.d.id].content = d.d.content; }
                const newMsg = { ...messageStore[d.d.id] || {}, ...d.d, author: (messageStore[d.d.id]||{}).author || d.d.author }; if(newMsg.author) el.outerHTML = createMessageElement(newMsg, false).outerHTML; 
            } 
        } 
    }; 
    ws.onclose = () => { if (heartbeatInterval) clearInterval(heartbeatInterval); if (currentAccount && !document.getElementById('auth-section').classList.contains('flex')) setTimeout(connectWS, 5000); }; 
    ws.onerror = e => { console.error('WS Error:', e); ws.close(); }; 
}

// --- Utilities & Handlers ---
function updatePings(id, count, isDm, guildId=null) { if (count > 0) { if (isDm) pingCounts[id] = { isDm: true }; else pingCounts[id] = { isDm: false, guildId: guildId }; } else { delete pingCounts[id]; } updatePingDots(); }
function updatePingDots() { document.querySelectorAll('.ping-dot').forEach(d=>d.remove()); Object.keys(pingCounts).forEach(id=>{ const el = document.getElementById(`channel-${id}`); if (el && !el.querySelector('.ping-dot')) el.insertAdjacentHTML('beforeend', '<div class="ping-dot"></div>'); const {guildId} = pingCounts[id]; if (guildId) { const gEl = document.getElementById(`guild-${guildId}`); if (gEl && !gEl.querySelector('.ping-dot')) gEl.insertAdjacentHTML('beforeend', '<div class="ping-dot"></div>'); } }); }

async function checkTimeoutStatus(guildId) { 
    if (timeoutInterval) clearInterval(timeoutInterval); 
    const { data: m } = await apiRequest(currentAccount.token, `/guilds/${guildId}/members/${currentAccount.id}`); 
    const end = m && m.communication_disabled_until ? new Date(m.communication_disabled_until) : null; 
    if (end && end > new Date()) { 
        const update = () => { 
            const now = new Date(), diff = (end - now) / 1000; 
            if (diff <= 0) { 
                setInputState(true); 
                clearInterval(timeoutInterval); 
            } else { 
                const d = Math.floor(diff/86400);
                const h = Math.floor(diff/3600)%24;
                const m = Math.floor(diff/60)%60;
                const s = Math.floor(diff%60); 
                const timeStr = `タイムアウト中: ${d>0?`${d}d `:''}${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
                setInputState(false, timeStr); 
            } 
        }; 
        update(); 
        timeoutInterval = setInterval(update, 1000); 
    } else {
        setInputState(true); 
    }
}

function setInputState(enabled, placeholder="メッセージを送信") { 
    const i = document.getElementById('message-input');
    const s = document.getElementById('send-button'); 
    i.disabled = !enabled; 
    i.placeholder = placeholder; 
    s.disabled = !enabled || (i.value.trim() === '' && !attachedFile); 
}

function handleInput() { 
    const i = document.getElementById('message-input');
    const c = document.getElementById('char-counter');
    const popup = document.getElementById('popup-picker'); 
    i.style.height = 'auto'; 
    i.style.height = (i.scrollHeight) + 'px'; 
    const val = i.value;
    const l = val.length; 
    c.textContent = l > 0 ? `${l}/${maxCharCount}` : ''; 
    c.style.color = l > maxCharCount ? 'red' : ''; 
    setInputState(!i.disabled); 
    
    if (val.startsWith('/')) { 
        const query = val.substring(1); 
        if (commandDebounce) clearTimeout(commandDebounce); 
        commandDebounce = setTimeout(async () => { 
            const cmds = await searchSlashCommands(query, currentChannel.id); 
            renderPopup(cmds, 'command'); 
        }, 300); 
        return; 
    } 
    
    const cursor = i.selectionEnd; 
    const atMatch = val.substring(0, cursor).match(/@(\S*)$/); 
    if (atMatch && currentChannel?.guild_id) { 
        const query = atMatch[1]; 
        if (!query) { popup.classList.add('hidden'); return; } 
        if (memberDebounce) clearTimeout(memberDebounce); 
        memberDebounce = setTimeout(async () => { 
            const members = await searchMembers(query, currentChannel.guild_id); 
            renderPopup(members, 'mention', cursor - query.length - 1); 
        }, 300); 
    } else { 
        popup.classList.add('hidden'); 
    } 
}

function startReply(m) { replyingTo = { messageId: m.id, author: m.author }; document.getElementById('reply-bar').classList.remove('hidden'); document.getElementById('reply-username').innerText = `@${m.author.global_name || m.author.username}`; document.getElementById('message-input').focus(); }
function cancelReply() { replyingTo = null; document.getElementById('reply-bar').classList.add('hidden'); }
async function deleteMessage(id, e) { if (!currentChannel) return; if (e.shiftKey || confirm("本当にこのメッセージを削除しますか？")) { await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages/${id}`, 'DELETE'); } }
function startEdit(id) { const msgEl = document.getElementById(`message-${id}`); if (!msgEl) return; const contentEl = msgEl.querySelector('.message-content-text'); if (!contentEl) return; const original = contentEl.dataset.originalContent; contentEl.innerHTML = `<textarea class="input-field w-full p-2 text-sm">${original}</textarea><div class="text-xs mt-1">escで<b class="text-[var(--text-link)] cursor-pointer">キャンセル</b> • enterで<b class="text-[var(--text-link)] cursor-pointer">保存</b></div>`; const textarea = contentEl.querySelector('textarea'); textarea.focus(); textarea.selectionStart = textarea.value.length; textarea.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); cancelEdit(id, original); } if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(id); } }; contentEl.querySelectorAll('b')[0].onclick = () => cancelEdit(id, original); contentEl.querySelectorAll('b')[1].onclick = () => saveEdit(id); }
function cancelEdit(id, original) { const el = document.getElementById(`message-${id}`)?.querySelector('.message-content-text'); if (el) el.innerHTML = original.replace(/\n/g, '<br>'); }
async function saveEdit(id) { const el = document.getElementById(`message-${id}`), textarea = el?.querySelector('textarea'); if (!textarea) return; const newContent = textarea.value.trim(); if (newContent) { await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages/${id}`, 'PATCH', { content: newContent }); } else { deleteMessage(id); } }
function setAttachment(file) { if (!file) return; attachedFile = file; document.getElementById('attachment-preview-name').textContent = file.name; document.getElementById('attachment-preview-bar').classList.remove('hidden'); handleInput(); }
function cancelAttachment() { attachedFile = null; document.getElementById('file-input').value = ""; document.getElementById('attachment-preview-bar').classList.add('hidden'); handleInput(); }
function scrollToMessage(id) { const el = document.getElementById(`message-${id}`); if(el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('bg-yellow-500/10', 'transition-all', 'duration-1000'); setTimeout(()=>el.classList.remove('bg-yellow-500/10'), 2000); } }

function parseMarkdown(text) { 
    if (!text) return ''; 
    let html = text.replace(/</g, '&lt;').replace(/>/g, '&gt;'); 
    const codeBlocks = []; 
    html = html.replace(/```(?:[\w]*\n)?([\s\S]*?)```/g, (m, c) => { codeBlocks.push(`<span class="md-code-block">${c}</span>`); return `__CODE_BLOCK_${codeBlocks.length - 1}__`; }); 
    html = html.replace(/`([^`]+)`/g, (m, c) => { codeBlocks.push(`<span class="md-inline-code">${c}</span>`); return `__CODE_BLOCK_${codeBlocks.length - 1}__`; }); 
    html = html.replace(/\[([^\]]*)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2" target="_blank" class="text-[var(--text-link)] hover:underline">$1</a>'); 
    html = html.replace(/^> (.*$)/gm, '<div class="md-quote">$1</div>').replace(/^>>> ([\s\S]*)/gm, '<div class="md-quote">$1</div>'); 
    html = html.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\*(.*?)\*/g, '<i>$1</i>').replace(/__(.*?)__/g, '<u>$1</u>').replace(/~~(.*?)~~/g, '<s>$1</s>'); 
    html = html.replace(/(?<!href="|">)(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" class="text-[var(--text-link)] hover:underline">$1</a>'); 
    html = html.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => `<span class="mention">@${id}</span>`); 
    html = html.replace(/\n/g, '<br>'); 
    html = html.replace(/__CODE_BLOCK_(\d+)__/g, (m, i) => codeBlocks[i]); 
    return html; 
}

function renderClydeError(errorText) { const con = document.getElementById('message-container'); const el = document.createElement('div'); el.className = 'clyde-message flex gap-3 pt-1 pb-2'; const clydeSrc = '/assets/clyde.png', fallbackSrc = 'https://cdn.discordapp.com/app-assets/1089635038827593848/1089635038827593848.png'; el.innerHTML = `<img src="${clydeSrc}" onerror="this.src='${fallbackSrc}'" class="w-10 h-10 rounded-full mt-0.5 flex-shrink-0 object-contain"><div class="flex-1 min-w-0"><div><b class="text-sm">Clyde</b><span class="bg-blue-500 text-white text-[10px] px-1 rounded ml-1">BOT</span></div><div class="text-sm break-words text-[var(--text-primary)]">送信エラー: ${errorText}</div><div class="text-xs mt-1 text-[var(--text-secondary)]">このメッセージはあなただけに表示されています。<span onclick="this.closest('.clyde-message').remove()" class="cursor-pointer text-[var(--text-link)] hover:underline">このメッセージを削除する</span></div></div>`; con.appendChild(el); con.scrollTop = con.scrollHeight; }

function applyTheme() { 
    const b = document.getElementById('theme-toggle-btn'); 
    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme:dark)').matches)) { 
        document.documentElement.classList.add('dark'); if(b) b.innerHTML = sunIcon; 
    } else { 
        document.documentElement.classList.remove('dark'); if(b) b.innerHTML = moonIcon; 
    } 
}
function handleResize() { if (window.innerWidth >= 768) { showChatView(); document.getElementById('sidebar-view').classList.remove('hidden'); } else { if (currentChannel) showChatView(); else showSidebarView(); } }
function showSidebarView() { currentChannel = null; document.getElementById('sidebar-view').classList.remove('hidden'); document.getElementById('chat-section').classList.add('hidden'); }
function showChatView() { document.getElementById('sidebar-view').classList.add('hidden'); document.getElementById('chat-section').classList.remove('hidden'); document.getElementById('chat-section').classList.add('flex'); }

document.addEventListener('DOMContentLoaded', async () => {
    applyTheme(); await migrateOldData(); 
    const a = getAccounts(); let i = getActiveAccountId();
    if (a.length > 0 && a.find(acc => acc.id === i)) { switchAccount(i); } else { showLoginScreen(); }
    document.getElementById('add-account-button').onclick = () => addAccount(document.getElementById('token-input').value);
    document.getElementById('dm-icon').onclick = e => loadDms(e.currentTarget);
    document.getElementById('send-button').onclick = sendMessage;
    document.getElementById('cancel-reply-btn').onclick = cancelReply;
    document.getElementById('cancel-attachment-btn').onclick = cancelAttachment;
    document.getElementById('attach-button').onclick = () => document.getElementById('file-input').click();
    document.getElementById('file-input').onchange = e => { if (e.target.files.length > 0) setAttachment(e.target.files[0]); };
    document.getElementById('back-to-channels-btn').onclick = showSidebarView;
    document.getElementById('message-input').addEventListener('input', handleInput);
    document.getElementById('message-input').addEventListener('keypress', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    document.getElementById('message-container').addEventListener('scroll', e => { if (e.target.scrollTop < 100 && oldestMessageId) loadMoreMessages() });
    document.body.addEventListener('paste', e => { const file = e.clipboardData.files[0]; if (file) { e.preventDefault(); setAttachment(file); } });
    document.getElementById('theme-toggle-btn').addEventListener('click', () => { document.documentElement.classList.toggle('dark'); localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light'); applyTheme(); });
    document.getElementById('user-info-panel').onclick = () => document.getElementById('account-switcher').classList.toggle('hidden');
    document.getElementById('add-account-switcher-btn').onclick = () => { document.getElementById('account-switcher').classList.add('hidden'); showLoginScreen(); };
    document.getElementById('show-add-account-form-btn').onclick = () => showTokenInput(null);
    document.getElementById('back-to-accounts-btn').onclick = () => showLoginScreen();
    document.getElementById('settings-btn').onclick = renderSettingsModal;
    window.addEventListener('resize', handleResize);
    document.addEventListener('click', (e) => { if (!e.target.closest('#popup-picker') && !e.target.closest('#message-input')) document.getElementById('popup-picker').classList.add('hidden'); });
});
