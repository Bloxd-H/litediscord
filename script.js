const API_BASE = 'https://discord.com/api/v10';
let ws = null;
let currentAccount = null;
let currentChannel = null;
let lastSequence = null;
let heartbeatInterval = null;
let timeoutInterval = null;
let replyingTo = null;
let oldestMessageId = null;
let isLoadingMore = false;
let attachedFile = null;
let commandDebounce = null;
let memberDebounce = null;
let maxCharCount = 2000;
let guildFolders = [];
let guildDataMap = new Map();
let openFolderId = null; 
let pingCounts = {};
let messageStore = {}; 
let editedMessages = {}; 

const plugins = JSON.parse(localStorage.getItem('plugins')) || {
    showMeYourName: false,
    sendSeconds: false,
    messageLogger: true,
    clickAction: true,
    showCharacter: true
};

document.addEventListener('DOMContentLoaded', async () => {
    if (localStorage.theme === 'dark' || (!localStorage.theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
    }
    
    document.body.addEventListener('paste', e => {
        const file = e.clipboardData.files[0];
        if (file) {
            e.preventDefault();
            attachedFile = file;
            const previewBar = document.getElementById('attachment-preview-bar');
            previewBar.classList.remove('hidden');
            previewBar.classList.add('flex');
            document.getElementById('attachment-preview-name').innerText = attachedFile.name;
            handleInput();
        }
    });

    document.getElementById('dm-icon').onclick = loadDms;
    document.getElementById('send-button').onclick = sendMessage;
    
    document.getElementById('attach-button').onclick = () => {
        document.getElementById('file-input').click();
    };

    document.getElementById('file-input').onchange = (e) => {
        if (e.target.files[0]) {
            attachedFile = e.target.files[0];
            const previewBar = document.getElementById('attachment-preview-bar');
            previewBar.classList.remove('hidden');
            previewBar.classList.add('flex');
            document.getElementById('attachment-preview-name').innerText = attachedFile.name;
            handleInput();
        }
    };

    document.getElementById('cancel-attachment-btn').onclick = cancelAttachment;
    document.getElementById('cancel-reply-btn').onclick = cancelReply;
    
    document.getElementById('message-input').oninput = handleInput;
    document.getElementById('message-input').onkeypress = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    document.getElementById('back-to-channels-btn').onclick = showSidebarView;
    document.getElementById('open-settings-btn').onclick = (e) => {
        e.stopPropagation();
        renderSettingsModal();
    };
    
    // Explicit binding for account switching buttons inside auth screen
    document.getElementById('add-account-switcher-btn').onclick = () => {
        document.getElementById('account-switcher').classList.add('hidden');
        showLoginScreen();
    };

    window.addEventListener('resize', handleResize);

    const accounts = getAccounts();
    const activeId = getActiveAccountId();
    
    if (accounts.length > 0 && activeId) {
        switchAccount(activeId);
    } else {
        showLoginScreen();
    }
});

const getAccounts = () => JSON.parse(localStorage.getItem('accounts')) || [];
const saveAccounts = a => localStorage.setItem('accounts', JSON.stringify(a));
const getActiveAccountId = () => localStorage.getItem('activeAccountId');
const setActiveAccountId = id => localStorage.setItem('activeAccountId', id);

const generateSuperProperties = () => btoa(JSON.stringify({ 
    os: "Windows", 
    browser: "Chrome", 
    device: "", 
    system_locale: "ja", 
    browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", 
    browser_version: "120.0.0.0", 
    os_version: "10", 
    release_channel: "stable", 
    client_build_number: 262355 
}));

async function apiRequest(token, path, method = 'GET', body = null, isFormData = false) {
    const opts = { 
        method, 
        headers: { 
            'Authorization': token, 
            'X-Super-Properties': generateSuperProperties() 
        } 
    };
    if (body) {
        if (isFormData) {
            opts.body = body;
        } else {
            opts.body = JSON.stringify(body);
            opts.headers['Content-Type'] = 'application/json';
        }
    }
    try {
        const r = await fetch(`${API_BASE}${path}`, opts);
        if (r.status === 401) return { error: { message: "Unauthorized" }, status: 401 };
        const data = r.status === 204 ? {} : await r.json();
        if (!r.ok) return { error: data, status: r.status };
        return { data, status: r.status };
    } catch (e) {
        return { error: { message: "Network error" }, status: 0 };
    }
}

function cleanupState() {
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    currentChannel = null;
    lastSequence = null;
    attachedFile = null;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (timeoutInterval) clearInterval(timeoutInterval);
    
    document.getElementById('guild-list').innerHTML = '';
    document.getElementById('channel-list').innerHTML = '';
    document.getElementById('message-container').innerHTML = '';
    document.getElementById('guild-name').innerText = '';
    
    messageStore = {}; 
    guildFolders = []; 
    guildDataMap.clear();
    editedMessages = {};
    pingCounts = {};
    
    cancelReply();
    cancelAttachment();
}

function switchAccount(id) {
    cleanupState();
    setActiveAccountId(id);
    const accounts = getAccounts();
    const account = accounts.find(a => a.id === id);
    if (!account) { showLoginScreen(); return; }
    currentAccount = account;
    maxCharCount = (currentAccount.premium_type === 2) ? 4000 : 2000;
    document.getElementById('token-input').value = '';
    updateView('app');
    renderCurrentUserPanel();
    loadGuilds();
    setTimeout(connectWS, 100);
}

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
    cleanupState();
    updateView('auth');
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
        userInfo.classList.remove('hidden'); 
        userInfo.classList.add('flex');
        document.getElementById('relogin-name').innerText = account.global_name || account.username;
        document.getElementById('relogin-username').innerText = account.username;
        const avatar = account.avatar ? `https://cdn.discordapp.com/avatars/${account.id}/${account.avatar}.png?size=128` : `https://cdn.discordapp.com/embed/avatars/${account.discriminator % 5}.png`;
        document.getElementById('relogin-avatar').src = avatar;
        
        document.getElementById('token-label').innerText = '新しいトークン';
        document.getElementById('add-account-button-text').innerText = 'アカウントを更新';
        document.getElementById('add-account-button').onclick = () => addAccount(document.getElementById('token-input').value, account.id);
    } else {
        document.getElementById('auth-title').innerText = 'アカウントを追加';
        userInfo.classList.add('hidden'); 
        userInfo.classList.remove('flex');
        document.getElementById('token-label').innerText = 'トークン';
        document.getElementById('add-account-button-text').innerText = 'ログイン';
        document.getElementById('add-account-button').onclick = () => addAccount(document.getElementById('token-input').value);
    }
}

function handleResize() { 
    if (window.innerWidth >= 768) {
        showChatView();
        document.getElementById('sidebar-view').classList.remove('hidden');
    } else if (currentChannel) {
        showChatView();
    } else {
        showSidebarView(); 
    }
}
function showSidebarView() { 
    document.getElementById('sidebar-view').classList.remove('hidden'); 
    document.getElementById('chat-section').classList.add('hidden'); 
}
function showChatView() { 
    document.getElementById('sidebar-view').classList.add('hidden'); 
    document.getElementById('chat-section').classList.remove('hidden'); 
    document.getElementById('chat-section').classList.add('flex'); 
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
        div.onclick = (e) => { 
            if (e.target.closest('.delete-btn')) return; 
            switchAccount(acc.id); 
        };
        div.querySelector('.delete-btn').onclick = (e) => deleteAccount(acc.id, e);
        list.appendChild(div);
    });
}

function renderCurrentUserPanel() {
    if (!currentAccount) return;
    const nameEl = document.getElementById('current-user-name');
    const subEl = document.getElementById('current-user-subtext');
    const avCont = document.getElementById('current-user-avatar-container');
    
    nameEl.textContent = currentAccount.global_name || currentAccount.username;
    subEl.textContent = `@${currentAccount.username}`;
    
    const avatar = currentAccount.avatar ? `https://cdn.discordapp.com/avatars/${currentAccount.id}/${currentAccount.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${currentAccount.discriminator % 5}.png`;
    let deco = '';
    if(currentAccount.avatar_decoration_data) {
        const decoUrl = `https://cdn.discordapp.com/avatar-decoration-presets/${currentAccount.avatar_decoration_data.asset}.png?size=96`;
        deco = `<img src="${decoUrl}" class="avatar-decoration">`;
    }
    avCont.innerHTML = `<img src="${avatar}" class="avatar-img shadow-sm rounded-full">${deco}`;
    renderAccountSwitcher();
}

function renderAccountSwitcher() {
    const list = document.getElementById('account-list');
    const accounts = getAccounts();
    const activeId = getActiveAccountId();
    
    list.innerHTML = accounts.map(acc => {
        const av = acc.avatar ? `https://cdn.discordapp.com/avatars/${acc.id}/${acc.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${acc.discriminator % 5}.png`;
        const isActive = acc.id === activeId;
        return `<div class="flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-[var(--button-bg)] hover:text-white group" onclick="switchAccount('${acc.id}')">
            <img src="${av}" class="w-8 h-8 rounded-full">
            <span class="flex-1 truncate text-sm font-semibold">${acc.global_name || acc.username}</span> 
            ${isActive ? '<div class="w-2 h-2 rounded-full bg-green-500"></div>' : ''} 
            <div onclick="deleteAccount('${acc.id}',event)" title="削除" class="hidden group-hover:block p-1 hover:bg-black/20 rounded-full">
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"></path></svg>
            </div>
        </div>`;
    }).join('');
}

function createServerIconElement(s, isInFolder = false) {
    let el = document.createElement('div'); 
    el.id = `guild-${s.id}`; 
    el.className = 'server-icon group ' + (isInFolder ? 'in-folder' : '');
    el.title = s.name;
    el.onclick = () => loadChannels(s, el);
    
    if (s.icon) {
        el.innerHTML = `<img src="https://cdn.discordapp.com/icons/${s.id}/${s.icon}.png?size=128" class="object-cover w-full h-full transition-all group-hover:rounded-2xl rounded-[50%]">`;
    } else {
        el.innerHTML = `<div class="w-full h-full flex items-center justify-center bg-gray-700 text-white font-bold text-sm transition-all group-hover:rounded-2xl rounded-[50%]">${s.name.substring(0, 2)}</div>`;
    }
    return el;
}

function renderFolders() {
    const list = document.getElementById('guild-list');
    list.innerHTML = '';
    
    guildFolders.forEach(item => {
        if (!item.guild_ids || item.guild_ids.length === 0) return;
        
        if (item.id) {
            const folderWrap = document.createElement('div');
            folderWrap.className = 'server-folder-wrapper flex flex-col items-center gap-2 w-full transition-all';
            folderWrap.id = `folder-${item.id}`;
            
            const containedGuilds = item.guild_ids.map(id => guildDataMap.get(id)).filter(Boolean);
            if (containedGuilds.length === 0) return;

            const header = document.createElement('div');
            header.className = 'folder-closed group'; 
            
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

            let folderColor = 'rgba(88, 101, 242, 0.4)';
            if (item.color) {
                const r = (item.color >> 16) & 255; const g = (item.color >> 8) & 255; const b = item.color & 255;
                folderColor = `rgba(${r},${g},${b},0.4)`;
            }
            header.style.backgroundColor = folderColor;

            const contentDiv = document.createElement('div');
            contentDiv.className = 'hidden flex-col gap-2 items-center w-full transition-all py-1';
            containedGuilds.forEach(g => contentDiv.appendChild(createServerIconElement(g, true)));

            header.onclick = () => {
                const isOpen = openFolderId === item.id;
                if (isOpen) {
                    openFolderId = null;
                    contentDiv.classList.add('hidden'); contentDiv.classList.remove('flex');
                    header.classList.remove('folder-opened'); header.classList.add('folder-closed');
                    header.style.backgroundColor = folderColor;
                    createMiniGrid();
                } else {
                    if (openFolderId) {
                        const prevOpen = document.querySelector(`#folder-${openFolderId} .folder-opened`);
                        if (prevOpen) prevOpen.click(); 
                    }
                    openFolderId = item.id;
                    contentDiv.classList.remove('hidden'); contentDiv.classList.add('flex');
                    header.classList.remove('folder-closed'); header.classList.add('folder-opened');
                    header.innerHTML = `<div class="text-white opacity-80 w-6 h-6"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M20 7H12L10 5H4C2.9 5 2.01 5.9 2.01 7L2 19C2 20.1 2.9 21 4 21H20C21.1 21 22 20.1 22 19V9C22 7.9 21.1 7 20 7Z"/></svg></div>`;
                    header.style.backgroundColor = 'rgba(88, 101, 242, 0.3)';
                }
            };
            folderWrap.appendChild(header); 
            folderWrap.appendChild(contentDiv);
            list.appendChild(folderWrap);
        } else {
            item.guild_ids.forEach(gid => {
                const s = guildDataMap.get(gid);
                if (s) list.appendChild(createServerIconElement(s));
            });
        }
    });
}

async function loadGuilds() {
    if (!currentAccount) return;
    const res = await apiRequest(currentAccount.token, '/users/@me/guilds');
    if (res.error) {
        if (res.status === 401) showLoginScreen(currentAccount);
        return;
    }
    guildDataMap.clear();
    res.data.forEach(s => guildDataMap.set(s.id, s));
    
    if (guildFolders.length > 0) { renderFolders(); } else {
        const list = document.getElementById('guild-list');
        list.innerHTML = '';
        res.data.forEach(s => list.appendChild(createServerIconElement(s)));
    }
}

async function loadDms() {
    if (!currentAccount) return;
    
    document.querySelectorAll('.server-icon.active').forEach(e => e.classList.remove('active'));
    document.getElementById('dm-icon').classList.add('active');
    document.getElementById('guild-name').innerText = 'Direct Messages';
    
    const res = await apiRequest(currentAccount.token, '/users/@me/channels');
    if (res.error) return;
    
    const list = document.getElementById('channel-list');
    list.innerHTML = '';
    const dms = res.data.sort((a,b) => (b.last_message_id||0) - (a.last_message_id||0));
    
    dms.forEach(dm => {
        const div = document.createElement('div');
        div.className = "channel-item p-1.5 pl-3 rounded-md cursor-pointer mb-0.5 text-[0.95em] truncate flex items-center";
        
        let icon = '<span class="text-xl mr-2 text-[var(--text-secondary)]">@</span>';
        let name = "DM";
        if(dm.recipients && dm.recipients[0]) {
            const user = dm.recipients[0];
            const av = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=32` : 'https://cdn.discordapp.com/embed/avatars/0.png';
            icon = `<img src="${av}" class="w-5 h-5 mr-2 rounded-full">`;
            name = user.global_name || user.username;
        }
        
        div.innerHTML = `${icon}<span>${name}</span>`;
        div.onclick = () => selectChannel(dm);
        list.appendChild(div);
    });
    updatePingDots();
}

async function loadChannels(g, element) {
    if (!currentAccount) return;
    document.querySelectorAll('.server-icon.active').forEach(e => e.classList.remove('active'));
    if (element) element.classList.add('active');
    
    document.getElementById('guild-name').innerText = g.name;
    const res = await apiRequest(currentAccount.token, `/guilds/${g.id}/channels`);
    if (res.error) return;
    
    const list = document.getElementById('channel-list');
    list.innerHTML = '';
    const channels = res.data;
    const grouped = channels.reduce((acc, ch) => { 
        (acc[ch.parent_id || 'null'] = acc[ch.parent_id || 'null'] || []).push(ch); 
        return acc; 
    }, {});
    
    Object.values(grouped).forEach(arr => arr.sort((a, b) => a.position - b.position));
    
    const renderChannelItem = (ch, catId = null) => {
        if (![0, 5, 2].includes(ch.type)) return;
        const div = document.createElement('div'); 
        div.id = `channel-${ch.id}`; 
        div.className = `channel-item p-1.5 pl-3 rounded-md cursor-pointer mb-0.5 text-[0.95em] truncate flex items-center relative ${catId ? 'channel-child-'+catId : ''}`; 
        
        const icon = ch.type === 2 
            ? '<svg class="w-5 h-5 mr-1.5 opacity-60" fill="currentColor" viewBox="0 0 24 24"><path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77zm-4 0a8.977 8.977 0 00-6.22 3.32l1.62 1.34C6.54 6.78 7.68 6 9 6c2.37 0 4.54 1.05 5.96 2.7l1.7-1.39A8.932 8.932 0 0010 3.23zM5.16 8.78L2.73 11.2a8.96 8.96 0 000 3.19l2.43 2.43 1.54-1.54-.78-.79c-.28-.56-.45-1.19-.45-1.87s.17-1.3.45-1.86l.78-.78-1.54-1.54z"></path></svg>' 
            : '<span class="text-xl mr-2 text-[var(--text-secondary)] opacity-70">#</span>';
        div.innerHTML = `${icon}<span class="${ch.type===2?'':'font-medium'}">${ch.name}</span>`;
        if (ch.type !== 2) div.onclick = () => selectChannel(ch); 
        else div.classList.add('opacity-50', 'cursor-not-allowed');
        list.appendChild(div);
    };
    
    (grouped['null'] || []).forEach(ch => renderChannelItem(ch));
    channels.filter(i => i.type === 4).sort((x, y) => x.position - y.position).forEach(cat => {
        const h = document.createElement('div'); 
        h.className = 'px-2 pt-4 pb-1 text-xs font-bold uppercase text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer flex items-center select-none group'; 
        h.innerHTML = `<svg class="w-3 h-3 mr-1 category-arrow transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg> ${cat.name}`;
        h.onclick = () => toggleCategory(cat.id, h);
        list.appendChild(h); 
        (grouped[cat.id] || []).forEach(ch => renderChannelItem(ch, cat.id));
    });
    updatePingDots();
}

function toggleCategory(catId, headerEl) {
    const children = document.querySelectorAll(`.channel-child-${catId}`);
    const isCollapsed = headerEl.classList.contains('category-collapsed');
    if (isCollapsed) {
        headerEl.classList.remove('category-collapsed');
        children.forEach(c => c.classList.remove('channel-collapsed'));
    } else {
        headerEl.classList.add('category-collapsed');
        children.forEach(c => c.classList.add('channel-collapsed'));
    }
}

async function selectChannel(ch) {
    currentChannel = ch;
    oldestMessageId = null;
    isLoadingMore = false;
    cancelReply(); cancelAttachment();
    delete pingCounts[ch.id]; updatePingDots();
    
    document.querySelectorAll('.channel-item.active').forEach(e => e.classList.remove('active'));
    const cE = document.getElementById(`channel-${ch.id}`);
    if (cE) cE.classList.add('active');
    
    if (window.innerWidth < 768) showChatView();

    let name = ch.name || 'DM';
    if(ch.recipients && ch.recipients[0]) name = ch.recipients[0].global_name || ch.recipients[0].username;
    
    document.getElementById('channel-name-text').innerHTML = `<span class="text-[var(--text-secondary)] opacity-70 mr-1.5">#</span><span>${name}</span>`;
    
    const container = document.getElementById('message-container');
    container.innerHTML = '<div class="w-full h-full flex items-center justify-center"><div class="loader"></div></div>';
    handleInput(); 
    if (ch.guild_id) { checkTimeoutStatus(ch.guild_id); } else { setInputState(true); }
    
    const res = await apiRequest(currentAccount.token, `/channels/${ch.id}/messages?limit=50`);
    container.innerHTML = '';
    
    if (res.error) {
        if (res.status === 401) showLoginScreen(currentAccount);
        container.innerHTML = `<div class="p-8 text-center text-red-500 font-bold">アクセス権限がありません</div>`;
        return;
    }

    const msgs = res.data;
    if (msgs.length > 0) {
        oldestMessageId = msgs[msgs.length - 1].id;
        const fragment = document.createDocumentFragment();
        const arr = msgs.slice().reverse();
        for (let i = 0; i < arr.length; i++) {
             const m = arr[i];
             const prev = (i > 0) ? arr[i-1] : null;
             if (plugins.messageLogger) messageStore[m.id] = m;
             const isGrouped = prev && (prev.author.id === m.author.id) 
                && !m.referenced_message && !m.webhook_id && !prev.webhook_id 
                && (new Date(m.timestamp) - new Date(prev.timestamp) < 5 * 60 * 1000);
             
             const el = createMessageElement(m, isGrouped);
             el.dataset.authorId = m.author.id;
             fragment.appendChild(el);
        }
        container.appendChild(fragment);
        container.scrollTop = container.scrollHeight;
    }
}

function createMessageElement(m, isGrouped) {
    let contentHtml = parseMarkdown(m.content);
    if (m.mentions) {
        m.mentions.forEach(u => { 
            const name = u.global_name || u.username;
            contentHtml = contentHtml.replace(new RegExp(`<@!?${u.id}>`, 'g'), `<span class="mention">@${name}</span>`);
        });
    }
    if (m.sticker_items) {
        contentHtml += m.sticker_items.map(s => `<img src="https://media.discordapp.net/stickers/${s.id}.webp?size=160" class="w-32 h-32 mt-2 block"/>`).join('');
    }
    if (m.attachments?.length > 0) {
        m.attachments.forEach(a => {
            const isImg = a.content_type?.startsWith('image/');
            const isVid = a.content_type?.startsWith('video/');
            if(isImg) {
                contentHtml += `<a href="${a.url}" target="_blank" class="block mt-1"><img src="${a.url}" class="max-w-[300px] max-h-[300px] rounded-lg bg-[var(--bg-tertiary)] object-contain"></a>`;
            } else if(isVid) {
                contentHtml += `<video src="${a.url}" controls class="max-w-[300px] mt-2 rounded-lg bg-black block"></video>`;
            } else {
                contentHtml += `<div class="mt-2 p-3 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] flex items-center"><a href="${a.url}" target="_blank" class="text-[var(--text-link)] font-mono text-sm">${a.filename}</a></div>`;
            }
        });
    }
    if (m.embeds?.length > 0) contentHtml += m.embeds.map(renderEmbed).join('');

    const el = document.createElement('div'); 
    el.id = `message-${m.id}`; 
    el.className = `message-group ${isGrouped ? 'grouped' : ''}`;
    el.dataset.authorId = m.author.id;

    if (plugins.clickAction) el.addEventListener('dblclick', () => startReply(m));
    if (m.isSending) el.classList.add('message-sending');
    if (m.isFailed) el.classList.add('message-failed');

    let historyHtml = '';
    if(plugins.messageLogger && editedMessages[m.id]) {
        historyHtml = editedMessages[m.id];
    }

    const isMe = currentAccount && m.author.id === currentAccount.id;
    const delBtn = isMe ? `<button onclick="deleteMessage('${m.id}', event)" class="p-1 hover:bg-[var(--bg-primary)] rounded text-red-500"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>` : '';
    const editBtn = isMe ? `<button onclick="startEdit('${m.id}')" class="p-1 hover:bg-[var(--bg-primary)] rounded text-[var(--text-secondary)]"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>` : '';
    const replyBtn = `<button onclick='startReply(${JSON.stringify({id:m.id, author:m.author})})' class="p-1 hover:bg-[var(--bg-primary)] rounded text-[var(--text-secondary)]"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg></button>`;
    const toolbar = `<div class="message-toolbar absolute -top-4 right-4 rounded shadow-sm bg-[var(--bg-secondary)] flex items-center p-0.5 z-20">${editBtn}${delBtn}${replyBtn}</div>`;

    let headerAddon = '';
    let nameStyle = m.member?.color ? `style="color:#${m.member.color.toString(16).padStart(6,'0')}"` : '';
    if (m.deleted && plugins.messageLogger) {
         headerAddon += '<span class="text-red-500 text-[10px] font-bold mr-1">[DELETED]</span>';
    }
    
    // Grouped message rendering - Fixed alignment issues
    if (isGrouped) {
        const editedTag = m.edited_timestamp ? '<span class="edited-tag">(edited)</span>' : '';
        // Uses simple flex alignment; no left margin class here because wrapper handles flow
        el.innerHTML = `${toolbar} <div class="w-full pl-[56px] message-content-text relative">${historyHtml}${contentHtml}${editedTag}</div>`;
    } 
    // Ungrouped rendering
    else {
        const member = m.member || {}; 
        const name = member.nick || m.author.global_name || m.author.username;
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

        let refHtml = '';
        if (m.referenced_message) {
            const rm = m.referenced_message;
            const refName = rm.author ? (rm.author.global_name || rm.author.username) : "Unknown";
            const refAv = rm.author && rm.author.avatar ? `https://cdn.discordapp.com/avatars/${rm.author.id}/${rm.author.avatar}.png?size=16` : 'https://cdn.discordapp.com/embed/avatars/0.png';
            refHtml = `<div class="flex items-center gap-1 ml-[52px] mb-1 opacity-70 text-sm cursor-pointer hover:opacity-100 relative" onclick="scrollToMessage('${rm.id}')">
                <div class="reply-spine"></div>
                <img src="${refAv}" class="w-4 h-4 rounded-full"> 
                <span class="font-bold mr-1 text-[var(--text-primary)] whitespace-nowrap overflow-hidden">${refName}</span> 
                <span class="text-[var(--text-secondary)] truncate">${rm.content || '添付ファイル'}</span>
            </div>`;
        }

        const editedTag = m.edited_timestamp ? '<span class="edited-tag">(edited)</span>' : '';

        el.innerHTML = `
        ${refHtml}
        ${toolbar} 
        <div class="flex mt-0.5 items-start w-full"> 
            <div class="avatar-container mr-4 cursor-pointer active:translate-y-[1px]">
                <img src="${avUrl}" class="avatar-img shadow-sm hover:shadow-md transition-shadow rounded-full">${decoHtml}
            </div> 
            <div class="flex-1 min-w-0"> 
                <div class="flex items-center leading-[1.375rem]"> 
                    ${headerAddon} 
                    <span class="font-medium mr-1 cursor-pointer hover:underline" ${nameStyle}>${name}</span> 
                    ${usernameDisp}${botTag} 
                    <span class="ml-2 text-[0.75rem] text-[var(--text-secondary)] cursor-default">${timeStr}</span> 
                </div> 
                <div class="message-content-text whitespace-pre-wrap leading-[1.375rem] relative">
                    ${historyHtml}${contentHtml}${editedTag}
                </div> 
            </div> 
        </div>`;
    }

    if (m.deleted && plugins.messageLogger) {
         const contentDiv = el.querySelector('.message-content-text');
         if(contentDiv) contentDiv.classList.add('deleted-text');
    }

    const contentText = el.querySelector('.message-content-text');
    if(contentText) contentText.dataset.originalContent = m.content;
    
    return el;
}

async function sendMessage() {
    if (!currentChannel || !currentAccount) return;
    const input = document.getElementById('message-input');
    const content = input.value.trim();
    if (!content && !attachedFile) return;

    const tempId = `temp-${Date.now()}`;
    const fakeMsg = { 
        id: tempId, author: currentAccount, content: content, timestamp: new Date().toISOString(), isSending: true 
    };
    if (attachedFile) fakeMsg.attachments = [{ filename: attachedFile.name, url: '#' }];
    
    renderMsg(fakeMsg);
    
    input.value = ''; handleInput();
    const container = document.getElementById('message-container');
    container.scrollTop = container.scrollHeight; 

    let body; let isForm = false;
    const replyRef = replyingTo ? { message_id: replyingTo.messageId } : undefined;

    if (attachedFile) { 
        body = new FormData(); 
        body.append('payload_json', JSON.stringify({ content: content, message_reference: replyRef }));
        body.append('files[0]', attachedFile); 
        isForm = true; 
    } else {
        body = { content: content, message_reference: replyRef };
    }

    const res = await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages`, 'POST', body, isForm);
    if (!res.error) {
         cancelAttachment(); cancelReply();
    } else {
         const el = document.getElementById(`message-${tempId}`);
         if(el) {
             el.classList.remove('message-sending'); el.classList.add('message-failed');
         }
         renderClydeError('送信失敗: ' + (res.error.message || 'Unknown Error'));
    }
}

function handleInput() {
    const i = document.getElementById('message-input');
    const s = document.getElementById('send-button');
    const ctr = document.getElementById('char-counter');
    
    i.style.height = 'auto'; i.style.height = (i.scrollHeight) + 'px';
    const len = i.value.length;
    
    s.disabled = (i.value.trim() === '' && !attachedFile);
    
    if(plugins.showCharacter) {
        ctr.classList.remove('opacity-0');
        ctr.textContent = `${len} / ${maxCharCount}`;
        ctr.style.color = (len > maxCharCount) ? '#ed4245' : 'var(--text-secondary)';
    } else {
        ctr.classList.add('opacity-0');
    }
}

function connectWS() { 
    if (!currentAccount) return; 
    if (ws) ws.close();

    ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json'); 
    
    ws.onmessage = e => { 
        const d = JSON.parse(e.data); 
        if (d.s) lastSequence = d.s; 
        
        if (d.op === 10) { 
            heartbeatInterval = setInterval(()=>ws.send(JSON.stringify({op: 1, d: lastSequence})), d.d.heartbeat_interval); 
            ws.send(JSON.stringify({ op: 2, d: { token: currentAccount.token, properties: { $os: "linux", $browser: "disco", $device: "disco" } } })); 
        } else if (d.t === 'READY') {
             if (d.d.user_settings?.guild_folders) { 
                 guildFolders = d.d.user_settings.guild_folders; 
                 // Force re-render folders if websocket brings fresh structure
                 if (guildFolders.length > 0) renderFolders(); 
             }
        } else if (d.t === 'MESSAGE_CREATE') {
             if (d.d.channel_id === currentChannel?.id) { 
                if (d.d.author.id === currentAccount.id) {
                    document.querySelectorAll('.message-sending').forEach(e => e.remove());
                }
                renderMsg(d.d);
             }
             if(d.d.guild_id && d.d.mentions?.find(u=>u.id===currentAccount.id)) {
                 pingCounts[d.d.channel_id] = (pingCounts[d.d.channel_id]||0) + 1;
                 updatePingDots();
             }
        } else if (d.t === 'MESSAGE_UPDATE') {
             if (plugins.messageLogger && d.d.id) {
                 const old = messageStore[d.d.id];
                 if(old && d.d.content && old.content !== d.d.content) {
                     const prevHistory = editedMessages[d.d.id] || "";
                     const oldLine = `<div class="history-line">${parseMarkdown(old.content)}</div>`;
                     editedMessages[d.d.id] = prevHistory + oldLine;
                     
                     const combined = { ...old, ...d.d };
                     messageStore[d.d.id] = combined;
                     rerenderMessage(d.d.id, combined);
                 }
             }
        } else if (d.t === 'MESSAGE_DELETE') {
             const id = d.d.id;
             if (messageStore[id] && plugins.messageLogger) {
                 const m = messageStore[id];
                 m.deleted = true;
                 rerenderMessage(id, m);
             } else {
                 const el = document.getElementById(`message-${id}`);
                 if(el) el.remove();
             }
        }
    };
    ws.onclose = () => { setTimeout(connectWS, 5000); };
}

function renderMsg(m) {
    const container = document.getElementById('message-container');
    const lastEl = container.lastElementChild;
    let isGrouped = false;

    if (lastEl && !m.isSending && !lastEl.classList.contains('message-sending')) {
         const lastAuth = lastEl.dataset.authorId;
         if(lastAuth === m.author.id && !m.webhook_id && !m.referenced_message) {
             isGrouped = true;
         }
    }
    
    if (plugins.messageLogger) messageStore[m.id] = m;
    
    const el = createMessageElement(m, isGrouped);
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
}

function rerenderMessage(id, m) {
    const oldEl = document.getElementById(`message-${id}`);
    if (!oldEl) return;
    const isGrouped = oldEl.classList.contains('grouped');
    const newEl = createMessageElement(m, isGrouped);
    oldEl.replaceWith(newEl);
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

function deleteAccount(id, e) {
    if(e) e.stopPropagation(); 
    if (!e.shiftKey && !confirm("このアカウントを削除しますか？ (Shift+Clickでスキップ)")) return;
    let a = getAccounts(); a = a.filter(acc => acc.id !== id); saveAccounts(a);
    if (getActiveAccountId() === id || !getActiveAccountId()) { localStorage.removeItem('activeAccountId'); showLoginScreen(); }
    else { renderSavedAccountsList(); renderCurrentUserPanel(); }
}

async function deleteMessage(id, e) {
    if (e.shiftKey || confirm("メッセージを削除しますか？")) { 
        await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages/${id}`, 'DELETE'); 
    }
}

function startEdit(id) { 
    const msgEl = document.getElementById(`message-${id}`); 
    if (!msgEl) return; 
    const contentEl = msgEl.querySelector('.message-content-text'); 
    if (!contentEl) return; 
    const original = contentEl.dataset.originalContent || "";
    
    contentEl.innerHTML = `<textarea class="input-field w-full p-2 bg-[var(--bg-tertiary)] rounded outline-none h-auto border border-blue-500 font-sans" rows="3">${original}</textarea><div class="text-xs mt-1 text-[var(--text-link)] opacity-80">Enterで保存 - Escでキャンセル</div>`; 
    const t = contentEl.querySelector('textarea'); 
    t.focus(); 
    t.onkeydown = async (e) => { 
        if(e.key==='Enter' && !e.shiftKey) { 
            e.preventDefault(); 
            await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages/${id}`, 'PATCH', {content: t.value}); 
        } else if(e.key==='Escape'){ 
            selectChannel(currentChannel); 
        } 
    };
}

function startReply(m) { 
    replyingTo = { messageId: m.id, author: m.author }; 
    const bar = document.getElementById('reply-bar');
    bar.classList.remove('hidden'); bar.classList.add('flex'); 
    document.getElementById('reply-username').innerText = m.author.global_name || m.author.username; 
    document.getElementById('message-input').focus(); 
}

function cancelReply() { 
    replyingTo = null; 
    const bar = document.getElementById('reply-bar');
    bar.classList.remove('flex'); bar.classList.add('hidden'); 
}

function cancelAttachment() {
    attachedFile = null;
    document.getElementById('file-input').value = "";
    const preview = document.getElementById('attachment-preview-bar');
    preview.classList.remove('flex'); preview.classList.add('hidden');
    handleInput();
}

function scrollToMessage(id) {
    const el = document.getElementById(`message-${id}`);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('flash-highlight');
        setTimeout(() => el.classList.remove('flash-highlight'), 1500);
    }
}

function parseMarkdown(t) { 
    if (!t) return ''; 
    return t.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" class="text-[var(--text-link)] hover:underline">$1</a>'); 
}

function renderEmbed(e) { 
    return `<div style="border-left:4px solid ${e.color ? '#' + e.color.toString(16).padStart(6,'0') : '#ccc'};" class="bg-[var(--bg-tertiary)] p-3 rounded mt-1 max-w-xl text-sm break-words">${e.title ? `<b class="block mb-1">${e.title}</b>` : ''}${e.description ? `<span>${parseMarkdown(e.description)}</span>` : ''}</div>`; 
}

function renderClydeError(t) { 
    const c = document.getElementById('message-container'); 
    const html = `<div class="p-2 text-red-500 font-bold bg-[var(--error-bg)] rounded my-2 border-l-4 border-red-500">System: ${t}</div>`;
    c.insertAdjacentHTML('beforeend', html);
    c.scrollTop = c.scrollHeight; 
}

function updatePingDots() { 
    document.querySelectorAll('.ping-dot').forEach(e => e.remove());
    Object.keys(pingCounts).forEach(chId => {
        if(pingCounts[chId] > 0) {
             const el = document.getElementById(`channel-${chId}`);
             if (el && !el.querySelector('.ping-dot')) {
                 el.insertAdjacentHTML('beforeend', '<div class="ping-dot"></div>');
             }
        }
    });
}

function checkTimeoutStatus(guildId) { 
    if (timeoutInterval) clearInterval(timeoutInterval);
    setInputState(true);
}

function setInputState(enabled) { 
    const input = document.getElementById('message-input');
    input.disabled = !enabled;
    if(!enabled) input.placeholder = "送信権限がありません";
    else input.placeholder = "メッセージを送信";
}

function renderSettingsModal() {
    switchSettingsTab('plugins');
    renderPluginList();
    renderThemeTab();
    document.getElementById('settings-modal').classList.remove('hidden');
}

function switchSettingsTab(tabName) {
    document.querySelectorAll('.settings-tab-item').forEach(e => e.classList.remove('active'));
    document.getElementById(`tab-btn-${tabName}`).classList.add('active');
    document.getElementById('tab-content-plugins').classList.add('hidden');
    document.getElementById('tab-content-general').classList.add('hidden');
    document.getElementById(`tab-content-${tabName}`).classList.remove('hidden');
}

function renderPluginList() {
    const list = document.getElementById('plugin-list'); 
    list.innerHTML = '';
    const defs = [
        { key: 'clickAction', name: 'Double Click Reply', desc: 'メッセージをダブルクリックして返信します' },
        { key: 'showMeYourName', name: 'Show Me Your Name', desc: 'ユーザー名の横に(@username)を表示' },
        { key: 'sendSeconds', name: 'SendSeconds', desc: '送信時刻の秒数まで表示' },
        { key: 'messageLogger', name: 'MessageLogger', desc: '削除/編集履歴を保持して表示' },
        { key: 'showCharacter', name: 'Show Character Count', desc: '文字数を入力欄の右下に表示' }
    ];
    defs.forEach(p => {
        const item = document.createElement('div');
        item.className = "plugin-item";
        item.innerHTML = `<div><div class="font-bold text-[var(--text-primary)]">${p.name}</div><div class="text-xs text-[var(--text-secondary)] mt-0.5">${p.desc}</div></div><label class="switch"><input type="checkbox" ${plugins[p.key]?'checked':''} data-key="${p.key}"><span class="slider"></span></label>`;
        item.querySelector('input').onchange = (e) => {
            plugins[p.key] = e.target.checked;
            localStorage.setItem('plugins', JSON.stringify(plugins));
            handleInput(); 
        }
        list.appendChild(item);
    });
}

function renderThemeTab() {
    const current = localStorage.theme || 'dark';
    document.getElementById('theme-check-dark').classList.toggle('hidden', current !== 'dark');
    document.getElementById('theme-check-light').classList.toggle('hidden', current !== 'light');
}

function setTheme(mode) {
    if(mode === 'dark') {
        document.documentElement.classList.add('dark');
        localStorage.theme = 'dark';
    } else {
        document.documentElement.classList.remove('dark');
        localStorage.theme = 'light';
    }
    renderThemeTab();
}
