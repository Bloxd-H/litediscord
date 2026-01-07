const API_BASE = 'https://discord.com/api/v10';
let ws = null, currentAccount = null, currentChannel = null;
let lastSequence = null, heartbeatInterval = null, timeoutInterval = null;
let replyingTo = null;
let oldestMessageId = null;
let isLoadingMore = false;
let attachedFile = null;
let commandDebounce = null;
let memberDebounce = null;
let guildFolders = [];
let guildDataMap = new Map();
let pingCounts = {};
let messageStore = {};
let editedMessages = {};
let isUserAtBottom = true; 

const plugins = JSON.parse(localStorage.getItem('plugins')) || {
    showMeYourName: false,
    sendSeconds: false,
    messageLogger: true,
    clickAction: true,
    showCharacter: true
};

const getAccounts = () => JSON.parse(localStorage.getItem('accounts')) || [];
const saveAccounts = a => localStorage.setItem('accounts', JSON.stringify(a));
const getActiveAccountId = () => localStorage.getItem('activeAccountId');
const setActiveAccountId = id => localStorage.setItem('activeAccountId', id);

const generateSuperProperties = () => btoa(JSON.stringify({ 
    os: "Windows", browser: "Chrome", device: "", system_locale: "ja", 
    browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", 
    browser_version: "120.0.0.0", os_version: "10", release_channel: "stable", client_build_number: 262355 
}));

document.addEventListener('DOMContentLoaded', async () => {
    if (localStorage.theme === 'dark' || (!localStorage.theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
    }
    
    document.body.addEventListener('paste', e => {
        const file = e.clipboardData.files[0];
        if (file) { e.preventDefault(); setAttachment(file); }
    });
    
    document.getElementById('message-container').addEventListener('scroll', handleScroll);
    document.getElementById('dm-icon').onclick = loadDms;
    document.getElementById('send-button').onclick = sendMessage;
    document.getElementById('attach-button').onclick = () => document.getElementById('file-input').click();
    document.getElementById('file-input').onchange = (e) => { if (e.target.files[0]) setAttachment(e.target.files[0]); };
    document.getElementById('cancel-attachment-btn').onclick = cancelAttachment;
    document.getElementById('cancel-reply-btn').onclick = cancelReply;
    document.getElementById('message-input').oninput = handleInput;
    document.getElementById('message-input').onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    };
    document.getElementById('back-to-channels-btn').onclick = showSidebarView;

    const accounts = getAccounts();
    const activeId = getActiveAccountId();
    if (accounts.length > 0 && activeId) switchAccount(activeId);
    else showLoginScreen();

    window.addEventListener('resize', () => {
        if(window.innerWidth >= 768) { 
            document.getElementById('sidebar-view').classList.remove('hidden'); 
            document.getElementById('chat-section').classList.remove('hidden');
        }
    });
});

async function apiRequest(token, path, method = 'GET', body = null, isFormData = false) {
    const opts = { method, headers: { 'Authorization': token, 'X-Super-Properties': generateSuperProperties() } };
    if (body) {
        if (isFormData) opts.body = body;
        else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    }
    try {
        const r = await fetch(`${API_BASE}${path}`, opts);
        if (r.status === 401) return { error: { message: "Unauthorized" }, status: 401 };
        const data = r.status === 204 ? {} : await r.json();
        if (!r.ok) return { error: data, status: r.status };
        return { data, status: r.status };
    } catch { return { error: { message: "Network error" }, status: 0 }; }
}

function handleScroll(e) {
    const con = e.target;
    isUserAtBottom = (con.scrollHeight - con.scrollTop - con.clientHeight) < 50;
    if (con.scrollTop < 100 && oldestMessageId && !isLoadingMore) loadMoreMessages();
}

function cleanupState() {
    if (ws) { ws.close(); ws = null; }
    currentChannel = null; lastSequence = null; attachedFile = null;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (timeoutInterval) clearInterval(timeoutInterval);
    document.getElementById('guild-list').innerHTML = '';
    document.getElementById('channel-list').innerHTML = '';
    document.getElementById('message-container').innerHTML = '';
    messageStore = {}; editedMessages = {}; pingCounts = {};
    cancelReply(); cancelAttachment();
}

function switchAccount(id) {
    cleanupState(); setActiveAccountId(id);
    const account = getAccounts().find(a => a.id === id);
    if (!account) { showLoginScreen(); return; }
    currentAccount = account;
    document.getElementById('token-input').value = '';
    updateView('app'); renderCurrentUserPanel(); loadGuilds();
    setTimeout(connectWS, 100);
}

function updateView(view) {
    const auth = document.getElementById('auth-section');
    const app = document.getElementById('main-app');
    if (view === 'auth') { auth.classList.remove('hidden'); auth.classList.add('flex'); app.classList.add('hidden'); app.classList.remove('flex'); }
    else { auth.classList.add('hidden'); auth.classList.remove('flex'); app.classList.remove('hidden'); app.classList.add('flex'); }
}

function showLoginScreen() {
    cleanupState(); updateView('auth');
    document.getElementById('token-input-view').classList.add('hidden');
    renderSavedAccountsList();
    if (getAccounts().length > 0) {
        document.getElementById('account-selection-view').classList.remove('hidden');
        document.getElementById('account-selection-view').classList.add('flex');
    } else {
        showTokenInput();
    }
}

function showTokenInput() {
    document.getElementById('account-selection-view').classList.add('hidden');
    document.getElementById('account-selection-view').classList.remove('flex');
    document.getElementById('token-input-view').classList.remove('hidden');
    document.getElementById('token-input-view').classList.add('flex');
}

function renderSavedAccountsList() {
    const list = document.getElementById('saved-accounts-list');
    const accounts = getAccounts();
    list.innerHTML = '';
    accounts.forEach(acc => {
        const div = document.createElement('div');
        div.className = "flex items-center gap-3 p-3 border border-gray-200 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-[#35373c] cursor-pointer transition-colors";
        const av = acc.avatar ? `https://cdn.discordapp.com/avatars/${acc.id}/${acc.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${acc.discriminator % 5}.png`;
        div.innerHTML = `<img src="${av}" class="w-10 h-10 rounded-full"><div class="flex-1"><div class="font-bold">${acc.global_name||acc.username}</div><div class="text-xs opacity-70">@${acc.username}</div></div>`;
        div.onclick = () => switchAccount(acc.id);
        list.appendChild(div);
    });
}

function renderCurrentUserPanel() {
    if (!currentAccount) return;
    document.getElementById('current-user-name').innerText = currentAccount.global_name || currentAccount.username;
    document.getElementById('current-user-subtext').innerText = `@${currentAccount.username}`;
    const av = currentAccount.avatar ? `https://cdn.discordapp.com/avatars/${currentAccount.id}/${currentAccount.avatar}.png?size=128` : `https://cdn.discordapp.com/embed/avatars/${currentAccount.discriminator % 5}.png`;
    
    let deco = '';
    if(currentAccount.avatar_decoration_data) {
        const decoUrl = `https://cdn.discordapp.com/avatar-decoration-presets/${currentAccount.avatar_decoration_data.asset}.png?size=96`;
        deco = `<img src="${decoUrl}" class="user-panel-decoration">`;
    }

    // Set SVG manually here to ensure it is not corrupted
    document.getElementById('open-settings-btn').innerHTML = `<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"></path><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" fill="var(--bg-secondary)"></path></svg>`;

    // Container 48x48 overflow visible, left negative margin to bulge out
    document.getElementById('current-user-avatar-container').innerHTML = `
        <div style="width: 44px; height: 44px; position: absolute; top:50%; left:50%; transform:translate(-50%,-50%);">
            <img src="${av}" class="w-full h-full rounded-full object-cover">
            ${deco}
        </div>`;
    
    const list = document.getElementById('account-list');
    list.innerHTML = getAccounts().map(acc => {
        const a = acc.avatar ? `https://cdn.discordapp.com/avatars/${acc.id}/${acc.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${acc.discriminator % 5}.png`;
        return `<div class="flex items-center gap-2 p-2 rounded hover:bg-[#5865f2] hover:text-white cursor-pointer" onclick="switchAccount('${acc.id}')"><img src="${a}" class="w-6 h-6 rounded-full"><span class="truncate text-sm flex-1">${acc.username}</span></div>`;
    }).join('');
}

async function loadGuilds() {
    const res = await apiRequest(currentAccount.token, '/users/@me/guilds');
    if (res.error) { if (res.status === 401) showLoginScreen(); return; }
    guildDataMap.clear();
    res.data.forEach(s => guildDataMap.set(s.id, s));
    if (guildFolders.length > 0) renderFolders();
    else {
        const l = document.getElementById('guild-list'); l.innerHTML = '';
        res.data.forEach(s => l.appendChild(createServerIcon(s)));
    }
}

function createServerIcon(s) {
    const el = document.createElement('div');
    el.id = `guild-${s.id}`; el.className = 'server-icon group mb-2'; el.title = s.name;
    el.innerHTML = s.icon ? `<img src="https://cdn.discordapp.com/icons/${s.id}/${s.icon}.png?size=128" class="w-full h-full object-cover">` : `<div class="text-sm font-bold">${s.name.substring(0,2)}</div>`;
    el.onclick = () => loadChannels(s, el);
    return el;
}

function renderFolders() {
    const l = document.getElementById('guild-list'); l.innerHTML = '';
    guildFolders.forEach(f => {
        if(!f.guild_ids.length) return;
        if(f.id) {
            const w = document.createElement('div'); w.className = 'flex flex-col items-center gap-2 w-full mb-2';
            const head = document.createElement('div'); head.className = 'folder-closed';
            const cG = f.guild_ids.map(id=>guildDataMap.get(id)).filter(Boolean);
            cG.slice(0,4).forEach(g=>{ const i=document.createElement('img'); i.className='folder-icon-thumb'; i.src=g.icon?`https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`:`https://cdn.discordapp.com/embed/avatars/0.png`; head.appendChild(i); });
            const content = document.createElement('div'); content.className = 'hidden flex-col gap-2';
            cG.forEach(g => {
                const sEl = createServerIcon(g); sEl.classList.add('in-folder');
                content.appendChild(sEl);
            });
            head.onclick = () => {
                const open = content.classList.contains('hidden');
                content.classList.toggle('hidden', !open); content.classList.toggle('flex', open);
                head.innerHTML = open ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M20 7H12L10 5H4C2.9 5 2.01 5.9 2.01 7L2 19C2 20.1 2.9 21 4 21H20C21.1 21 22 20.1 22 19V9C22 7.9 21.1 7 20 7Z"/></svg>` : '';
                if(!open) { head.innerHTML = ''; cG.slice(0,4).forEach(g=>{ const i=document.createElement('img'); i.className='folder-icon-thumb'; i.src=g.icon?`https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`:`https://cdn.discordapp.com/embed/avatars/0.png`; head.appendChild(i); }); }
                head.className = open ? 'folder-opened' : 'folder-closed';
            };
            w.appendChild(head); w.appendChild(content); l.appendChild(w);
        } else f.guild_ids.forEach(id=>{ const s=guildDataMap.get(id); if(s) l.appendChild(createServerIcon(s)); });
    });
}

async function loadChannels(g, el) {
    document.querySelectorAll('.server-icon.active').forEach(e=>e.classList.remove('active')); if(el) el.classList.add('active');
    document.getElementById('guild-name').innerText = g.name;
    const res = await apiRequest(currentAccount.token, `/guilds/${g.id}/channels`);
    if(res.error) return;
    renderChannels(res.data);
}

async function loadDms() {
    document.querySelectorAll('.server-icon.active').forEach(e=>e.classList.remove('active')); document.getElementById('dm-icon').classList.add('active');
    document.getElementById('guild-name').innerText = 'Direct Messages';
    const res = await apiRequest(currentAccount.token, `/users/@me/channels`);
    if(res.data) renderChannels(res.data, true);
}

function renderChannels(channels, isDm = false) {
    const list = document.getElementById('channel-list'); list.innerHTML = '';
    if(isDm) {
        channels.sort((a,b)=>(b.last_message_id||0)-(a.last_message_id||0));
        channels.forEach(c => {
            const u = c.recipients[0];
            const d = document.createElement('div'); d.className = "channel-item p-1.5 pl-3 cursor-pointer mb-0.5 truncate flex items-center";
            d.id = `channel-${c.id}`;
            const av = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=32` : `https://cdn.discordapp.com/embed/avatars/${u.discriminator%5}.png`;
            d.innerHTML = `<img src="${av}" class="w-6 h-6 rounded-full mr-2"> ${u.global_name||u.username}`;
            d.onclick = () => selectChannel(c);
            list.appendChild(d);
        });
    } else {
        const grouped = channels.reduce((a,c)=>{(a[c.parent_id||'null']=a[c.parent_id||'null']||[]).push(c); return a}, {});
        const draw = (ch) => {
            if(![0,5,2].includes(ch.type)) return;
            const d = document.createElement('div'); d.className = `channel-item p-1.5 pl-3 rounded-md cursor-pointer mb-0.5 truncate text-[15px] ${ch.type===2?'opacity-60 cursor-not-allowed':''}`;
            d.id = `channel-${ch.id}`;
            d.innerHTML = `${ch.type===2?'🔊 ':'<span class="opacity-60 text-lg mr-1">#</span> '}${ch.name}`;
            if(ch.type!==2) d.onclick=()=>selectChannel(ch);
            list.appendChild(d);
        };
        (grouped['null']||[]).sort((a,b)=>a.position-b.position).forEach(draw);
        channels.filter(c=>c.type===4).sort((a,b)=>a.position-b.position).forEach(cat => {
            const cDiv = document.createElement('div');
            cDiv.className = 'mt-4 mb-1 text-xs font-bold text-gray-500 uppercase flex items-center cursor-pointer';
            cDiv.innerHTML = `<svg class="w-3 h-3 mr-1 category-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg> ${cat.name}`;
            const sub = document.createElement('div');
            cDiv.onclick = () => { sub.classList.toggle('hidden'); cDiv.classList.toggle('category-collapsed'); };
            list.appendChild(cDiv); list.appendChild(sub);
            (grouped[cat.id]||[]).sort((a,b)=>a.position-b.position).forEach(ch => {
                // Modified helper for category children
                if(![0,5,2].includes(ch.type)) return;
                const d = document.createElement('div'); d.className = `channel-item p-1.5 pl-3 rounded-md cursor-pointer mb-0.5 truncate text-[15px] ${ch.type===2?'opacity-60 cursor-not-allowed':''}`;
                d.id = `channel-${ch.id}`;
                d.innerHTML = `${ch.type===2?'🔊 ':'<span class="opacity-60 text-lg mr-1">#</span> '}${ch.name}`;
                if(ch.type!==2) d.onclick=()=>selectChannel(ch);
                sub.appendChild(d);
            });
        });
    }
}

async function selectChannel(ch) {
    currentChannel = ch; oldestMessageId = null; isLoadingMore = false; isUserAtBottom = true;
    document.querySelectorAll('.channel-item.active').forEach(e=>e.classList.remove('active'));
    document.getElementById(`channel-${ch.id}`)?.classList.add('active');
    
    const name = ch.name || ch.recipients?.[0]?.username || "DM";
    document.getElementById('channel-name-text').innerText = name;
    if(window.innerWidth < 768) { document.getElementById('sidebar-view').classList.add('hidden'); document.getElementById('chat-section').classList.remove('hidden'); document.getElementById('chat-section').classList.add('flex'); }
    
    const con = document.getElementById('message-container');
    con.innerHTML = '<div class="loader m-auto"></div>';
    
    const res = await apiRequest(currentAccount.token, `/channels/${ch.id}/messages?limit=50`);
    con.innerHTML = '';
    
    if (res.data && res.data.length > 0) {
        oldestMessageId = res.data[res.data.length - 1].id;
        const rev = res.data.reverse();
        const frag = document.createDocumentFragment();
        let lastId = null;
        let lastTime = 0;
        
        rev.forEach(m => {
            if(plugins.messageLogger) messageStore[m.id] = m;
            let grouped = false;
            if(lastId === m.author.id && !m.referenced_message && !m.webhook_id && (new Date(m.timestamp).getTime() - lastTime < 300000)) grouped = true;
            const el = createMessageElement(m, grouped);
            frag.appendChild(el);
            lastId = m.author.id; lastTime = new Date(m.timestamp).getTime();
        });
        con.appendChild(frag);
        con.scrollTop = con.scrollHeight;
    }
}

async function loadMoreMessages() {
    if (isLoadingMore || !oldestMessageId || !currentChannel) return;
    isLoadingMore = true;
    const con = document.getElementById('message-container');
    const oldH = con.scrollHeight;
    
    const res = await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages?limit=50&before=${oldestMessageId}`);
    if (res.data && res.data.length > 0) {
        oldestMessageId = res.data[res.data.length-1].id;
        const msgs = res.data.reverse();
        const frag = document.createDocumentFragment();
        let lastId = null; let lastTime = 0;

        msgs.forEach((m, idx) => {
            if(plugins.messageLogger) messageStore[m.id] = m;
            let grouped = false;
            if (idx > 0) {
                 if (lastId === m.author.id && !m.referenced_message && !m.webhook_id && (new Date(m.timestamp).getTime() - lastTime < 300000)) grouped = true;
            }
            const el = createMessageElement(m, grouped);
            frag.appendChild(el);
            lastId = m.author.id; lastTime = new Date(m.timestamp).getTime();
        });
        con.prepend(frag);
        con.scrollTop = con.scrollHeight - oldH;
    } else oldestMessageId = null;
    isLoadingMore = false;
}

function createMessageElement(m, isGrouped) {
    let contentHtml = parseMarkdown(m.content);
    if(m.mentions) m.mentions.forEach(u=>{ contentHtml=contentHtml.replace(new RegExp(`<@!?${u.id}>`,'g'), `<span class="mention">@${u.global_name||u.username}</span>`); });
    if(m.stickers) contentHtml+=m.stickers.map(s=>`<img src="https://media.discordapp.net/stickers/${s.id}.webp?size=160" class="w-32 block mt-2">`).join('');
    
    let attachmentsHtml = '';
    if(m.attachments) m.attachments.forEach(a => {
        const type = m.deleted ? 'message-deleted-img' : '';
        if(a.content_type?.startsWith('image')) attachmentsHtml+=`<a href="${a.url}" target="_blank" class="block mt-2"><img src="${a.url}" class="max-w-[320px] max-h-[320px] rounded bg-[#2b2d31] object-contain ${type}"></a>`;
        else attachmentsHtml+=`<div class="mt-2 p-3 bg-[#2b2d31] rounded flex items-center border border-gray-700"><a href="${a.url}" target="_blank" class="text-blue-400 hover:underline">${a.filename}</a></div>`;
    });
    
    let embedsHtml = '';
    if(m.embeds) embedsHtml = m.embeds.map(e => {
        return `<div style="border-left:4px solid ${e.color ? '#' + e.color.toString(16).padStart(6,'0') : '#ccc'};" class="bg-[#2b2d31] p-3 rounded mt-2 max-w-lg text-sm break-words whitespace-normal block w-full">
            ${e.title ? `<b class="block mb-1 text-gray-100">${e.title}</b>` : ''}
            ${e.description ? `<span class="text-gray-300">${parseMarkdown(e.description)}</span>` : ''}
        </div>`.replace(/\n\s+/g, '');
    }).join('');

    const el = document.createElement('div');
    el.id = `message-${m.id}`;
    el.className = `message-group ${isGrouped?'grouped':''} flex flex-col relative w-full`;
    
    // Check Mentions
    if(currentAccount && m.mentions && m.mentions.some(u => u.id === currentAccount.id)) {
        el.classList.add('mention-highlight');
    }

    // Prepare History Text (Deleted Logic)
    let bodyClasses = "message-body whitespace-pre-wrap leading-6 break-words relative text-gray-100";
    let appendText = '';
    
    if (m.deleted) {
        bodyClasses += " message-deleted-text"; 
        appendText = ' <span class="text-xs opacity-80">(deleted)</span>';
    }

    // Logic Construction
    let refHtml = '';
    if (m.referenced_message && !isGrouped) {
        const rm = m.referenced_message;
        const ra = rm.author || {username:'Unknown', avatar:null};
        refHtml = `<div class="flex items-center gap-1 ml-[66px] mb-1 opacity-60 text-sm hover:opacity-100 relative cursor-pointer" onclick="scrollToMessage('${rm.id}')"><div class="reply-spine"></div><img src="${ra.avatar?`https://cdn.discordapp.com/avatars/${ra.id}/${ra.avatar}.png?size=16`:'https://cdn.discordapp.com/embed/avatars/0.png'}" class="w-4 h-4 rounded-full"> <span class="font-bold mr-1 text-gray-300">${ra.global_name||ra.username}</span> <span class="truncate text-gray-400 line-clamp-1">${rm.content||'Attachment'}</span></div>`;
    }

    const editTag = m.edited_timestamp ? '<span class="text-[10px] text-gray-500 ml-1">(edited)</span>' : '';
    const date = new Date(m.timestamp);
    const timeStr = plugins.sendSeconds ? date.toLocaleTimeString() : date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

    const fullBody = `${contentHtml}${editTag}${appendText}`;
    const accs = (attachmentsHtml || embedsHtml) ? `<div class="message-accessories mt-1">${attachmentsHtml}${embedsHtml}</div>` : '';

    const toolbar = `<div class="message-toolbar absolute -top-4 right-4 rounded shadow-sm flex items-center p-0.5 z-20"><button onclick='startReply(${JSON.stringify({id:m.id,author:m.author})})' class="p-1 hover:bg-gray-200 dark:hover:bg-[#3f4147] rounded text-gray-500"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg></button>
    ${(currentAccount && m.author.id===currentAccount.id) ? `<button onclick="deleteMessage('${m.id}', event)" class="p-1 hover:bg-red-500/10 rounded text-red-500"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>` : ''}</div>`;

    if (isGrouped) {
        el.innerHTML = `${toolbar} <div class="flex items-start w-full relative group"> <div class="w-[56px] shrink-0 text-xs text-gray-500 opacity-0 group-hover:opacity-100 text-right pr-3 select-none mt-1">${timeStr}</div> <div class="flex-1 min-w-0 pr-4"> <div class="${bodyClasses}">${fullBody}</div> ${accs} </div> </div>`.replace(/\n\s+/g,' ');
    } else {
        const mem = m.member || {};
        const nick = mem.nick || m.author.global_name || m.author.username;
        const av = mem.avatar ? `https://cdn.discordapp.com/guilds/${currentChannel.guild_id}/users/${m.author.id}/avatars/${mem.avatar}.png?size=64` : (m.author.avatar ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${m.author.discriminator%5}.png`);
        
        let deco = '';
        if(m.author.avatar_decoration_data) {
            deco = `<img src="https://cdn.discordapp.com/avatar-decoration-presets/${m.author.avatar_decoration_data.asset}.png?size=96" style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:120%; height:120%; max-width:none; pointer-events:none; z-index:20;">`;
        }

        el.innerHTML = `
        ${refHtml}
        ${toolbar} 
        <div class="flex mt-0.5 items-start w-full relative">
            <div class="mr-4 ml-4 relative flex-shrink-0 cursor-pointer hover:drop-shadow-sm active:translate-y-[1px]" style="width: 40px; height: 40px;">
                <img src="${av}" class="rounded-full w-full h-full object-cover relative z-10 block">
                ${deco}
            </div>
            <div class="flex-1 min-w-0 pr-4">
                <div class="flex items-baseline leading-tight">
                    <span class="font-medium mr-1 text-gray-100 hover:underline cursor-pointer" ${mem.color?`style="color:#${mem.color.toString(16).padStart(6,'0')}"`:''}>${nick}</span>
                    <span class="text-xs text-gray-500 ml-1">${timeStr}</span>
                </div>
                <div class="${bodyClasses}">
                    ${fullBody}
                </div>
                ${accs}
            </div>
        </div>`.replace(/\n\s+/g, ' ');
    }

    // Preservation for editing
    if(el.querySelector('.message-body')) {
        el.querySelector('.message-body').dataset.originalContent = m.content;
    }
    
    return el;
}

function parseMarkdown(t) {
    if (!t) return '';
    return t.replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" class="text-blue-400 hover:underline">$1</a>')
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
        .replace(/\n/g, '<br>');
}

async function sendMessage() {
    if(!currentChannel) return;
    const inp = document.getElementById('message-input');
    const txt = inp.value.trim();
    if(!txt && !attachedFile) return;

    const sendingFile = attachedFile; 
    setAttachment(null);
    cancelAttachment(); 
    inp.value = ''; handleInput(); 
    
    // Optimistic Render
    const now = new Date();
    const tempId = 'temp-'+now.getTime();
    renderMsg({
        id: tempId, author: currentAccount, content: txt, timestamp: now.toISOString(), 
        mentions: [], attachments: sendingFile ? [{url:'#', filename: sendingFile.name, content_type: sendingFile.type}] : [],
        isSending: true
    });

    const reply = replyingTo ? { message_id: replyingTo.messageId } : undefined;
    let body, isForm = false;
    
    if (sendingFile) {
        body = new FormData();
        body.append('payload_json', JSON.stringify({content: txt, message_reference: reply}));
        body.append('files[0]', sendingFile);
        isForm = true;
    } else {
        body = { content: txt, message_reference: reply };
    }
    
    cancelReply();

    const res = await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages`, 'POST', body, isForm);
    if(res.error) {
        const tEl = document.getElementById(`message-${tempId}`);
        if(tEl) tEl.classList.add('message-failed');
    }
}

function renderMsg(m, opt) {
    const con = document.getElementById('message-container');
    
    // Group Calculation
    let grouped = false;
    const lastEl = con.lastElementChild;
    if(lastEl && !m.referenced_message && !m.webhook_id) {
         if (lastEl.dataset.authorId === m.author.id) grouped = true; // Simple check for optimistic UI
    }
    
    const el = createMessageElement(m, grouped);
    el.dataset.authorId = m.author.id;
    con.appendChild(el);
    if(isUserAtBottom || m.author.id === currentAccount.id) {
        con.scrollTop = con.scrollHeight;
    }
}

async function addAccount(token) {
    const res = await apiRequest(token.trim(), '/users/@me');
    if (res.data) {
        let accs = getAccounts();
        if(!accs.some(a=>a.id===res.data.id)) accs.push({...res.data, token: token.trim()});
        else accs = accs.map(a=>a.id===res.data.id?{...res.data,token:token.trim()}:a);
        saveAccounts(accs); switchAccount(res.data.id);
    }
}

function connectWS() {
    if(!currentAccount) return;
    ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    ws.onmessage = (e) => {
        const p = JSON.parse(e.data);
        if(p.s) lastSequence = p.s;
        if(p.op === 10) {
            heartbeatInterval = setInterval(()=>ws.send(JSON.stringify({op:1, d:lastSequence})), p.d.heartbeat_interval);
            ws.send(JSON.stringify({op:2, d:{token:currentAccount.token, properties:{os:"windows",browser:"chrome",device:""}}}));
        }
        else if(p.t === 'MESSAGE_CREATE') {
            if(p.d.channel_id === currentChannel?.id) {
                // remove temp if exists
                if(p.d.nonce) { const t=document.querySelector(`[id^='message-temp-']`); if(t) t.remove(); }
                renderMsg(p.d);
            }
        }
        else if(p.t === 'MESSAGE_DELETE') {
            const el = document.getElementById(`message-${p.d.id}`);
            if(el) {
                if(plugins.messageLogger) {
                    const body = el.querySelector('.message-body');
                    if(body) { 
                        body.classList.add('message-deleted-text'); 
                        if(!body.innerHTML.includes('(deleted)')) body.insertAdjacentHTML('beforeend', ' <span class="text-xs opacity-80">(deleted)</span>');
                    }
                    const imgs = el.querySelectorAll('img:not(.avatar-img):not(.avatar-decoration)');
                    imgs.forEach(i => i.classList.add('message-deleted-img'));
                } else {
                    el.remove();
                }
            }
        }
    };
    ws.onclose = () => setTimeout(connectWS, 5000);
}

// Helpers
function handleInput() {
    const i = document.getElementById('message-input');
    const s = document.getElementById('send-button');
    i.style.height='auto'; i.style.height=(i.scrollHeight)+'px';
    const c = i.value.length;
    s.disabled = !c && !attachedFile;
    if(plugins.showCharacter) {
         document.getElementById('char-counter').textContent = c + '/2000';
         document.getElementById('char-counter').classList.remove('opacity-0');
    }
}

function setAttachment(f) { 
    if(!f) { attachedFile=null; return; }
    attachedFile = f; 
    document.getElementById('attachment-preview-bar').classList.remove('hidden'); 
    document.getElementById('attachment-preview-bar').classList.add('flex');
    document.getElementById('attachment-preview-name').innerText = f.name; 
    handleInput();
}
function cancelAttachment() { 
    setAttachment(null); 
    document.getElementById('file-input').value = ''; 
    document.getElementById('attachment-preview-bar').classList.add('hidden');
    document.getElementById('attachment-preview-bar').classList.remove('flex');
    handleInput();
}
function startReply(m) { 
    replyingTo = {messageId:m.id, author:m.author}; 
    document.getElementById('reply-bar').classList.remove('hidden'); 
    document.getElementById('reply-username').innerText = `@${m.author.username}`; 
}
function cancelReply() { replyingTo = null; document.getElementById('reply-bar').classList.add('hidden'); }
async function deleteMessage(id,e) { if(e.shiftKey||confirm('Delete?')) apiRequest(currentAccount.token,`/channels/${currentChannel.id}/messages/${id}`,'DELETE'); }
function scrollToMessage(id) { 
    const e = document.getElementById(`message-${id}`); 
    if(e){ e.scrollIntoView({block:'center',behavior:'smooth'}); e.classList.add('flash-highlight'); setTimeout(()=>e.classList.remove('flash-highlight'),1000); } 
}
function showSidebarView() {
    document.getElementById('sidebar-view').classList.remove('hidden');
    document.getElementById('chat-section').classList.add('hidden');
}
function setTheme(t) { localStorage.theme=t; if(t==='dark') document.documentElement.classList.add('dark'); else document.documentElement.classList.remove('dark'); }
function renderSettingsModal() { document.getElementById('settings-modal').classList.remove('hidden'); renderPluginList(); }
function renderPluginList() {
    const list = document.getElementById('plugin-list'); list.innerHTML='';
    const defs = [{k:'messageLogger',n:'Message Logger'},{k:'sendSeconds',n:'Seconds'},{k:'showMeYourName',n:'Show Name'}];
    defs.forEach(d=>{
        const row = document.createElement('div'); row.className='plugin-item';
        row.innerHTML=`<span>${d.n}</span><label class="switch"><input type="checkbox" ${plugins[d.k]?'checked':''}><span class="slider"></span></label>`;
        row.querySelector('input').onchange=(e)=>{ plugins[d.k]=e.target.checked; localStorage.setItem('plugins',JSON.stringify(plugins)); if(currentChannel) selectChannel(currentChannel); };
        list.appendChild(row);
    });
}
function switchSettingsTab(t) {
    document.querySelectorAll('.settings-tab-item').forEach(e=>e.classList.remove('active'));
    document.getElementById(`tab-btn-${t}`).classList.add('active');
    document.getElementById('tab-content-plugins').classList.toggle('hidden', t!=='plugins');
    document.getElementById('tab-content-general').classList.toggle('hidden', t!=='general');
}
