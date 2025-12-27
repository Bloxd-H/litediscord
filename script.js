    const API_BASE = 'https://discord.com/api/v10';
    let ws, currentAccount, currentChannel, lastSequence, heartbeatInterval, timeoutInterval;
    let lastMessageInfo = { authorId: null, timestamp: null };
    let replyingTo = null;
    let oldestMessageId = null;
    let pingCounts = {};
    let isLoadingMore = false;
    let attachedFile = null;
    let availableCommands = [];
    const sunIcon = `<svg class="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.707.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM10 18a1 1 0 01-1-1v-1a1 1 0 112 0v1a1 1 0 01-1 1zM4.05 14.536l.707-.707a1 1 0 10-1.414-1.414l-.707.707a1 1 0 001.414 1.414zM1.5 10a1 1 0 011-1h1a1 1 0 110 2H2.5a1 1 0 01-1-1zm15 0a1 1 0 011-1h1a1 1 0 110 2h-1a1 1 0 01-1-1zM5.464 5.05a1 1 0 010-1.414l.707-.707a1 1 0 111.414 1.414l-.707.707a1 1 0 01-1.414 0z"></path></svg>`;
    const moonIcon = `<svg class="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"></path></svg>`;

    const getAccounts = () => JSON.parse(localStorage.getItem('accounts')) || [];
    const saveAccounts = a => localStorage.setItem('accounts', JSON.stringify(a));
    const getActiveAccountId = () => localStorage.getItem('activeAccountId');
    const setActiveAccountId = id => localStorage.setItem('activeAccountId', id);

    const generateSuperProperties = () => btoa(JSON.stringify({ os: "Windows", browser: "Chrome", device: "", system_locale: "ja", browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", browser_version: "120.0.0.0", os_version: "10", release_channel: "stable", client_build_number: 262355 }));

    function cleanupState() {
        if (ws) ws.close();
        ws = null; currentChannel = null; lastSequence = null; attachedFile = null;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (timeoutInterval) clearInterval(timeoutInterval);
        document.getElementById('guild-list').innerHTML = '';
        document.getElementById('channel-list').innerHTML = '';
        document.getElementById('message-container').innerHTML = '';
        document.getElementById('guild-name').innerText = '';
        cancelReply(); cancelAttachment();
    }

    async function apiRequest(token, path, method = 'GET', body = null, isFormData = false) {
        const o = { method, headers: { 'Authorization': token, 'X-Super-Properties': generateSuperProperties() } };
        if (body) {
            if (isFormData) { o.body = body } else { o.body = JSON.stringify(body); o.headers['Content-Type'] = 'application/json'; }
        }
        try {
            const r = await fetch(`${API_BASE}${path}`, o);
            const data = r.status === 204 ? {} : await r.json();
            if (!r.ok) { return { error: data, status: r.status }; }
            return { data, status: r.status };
        } catch (e) {
            console.error("API Request Failed:", e);
            return { error: { message: "Network error" }, status: 0 };
        }
    }

    async function addAccount(token) {
        document.getElementById('login-error').innerText = "";
        if (!token || !token.trim()) { document.getElementById('login-error').innerText = "トークンは必須です。"; return }
        token = token.trim().replace(/^"|"$/g, '');
        const b = document.getElementById('add-account-button'), t = document.getElementById('add-account-button-text'), s = document.getElementById('login-spinner');
        t.classList.add('hidden'); s.classList.remove('hidden'); b.disabled = true;
        const result = await apiRequest(token, '/users/@me');
        t.classList.remove('hidden'); s.classList.add('hidden'); b.disabled = false;
        if (result.data && result.data.id) {
            const a = getAccounts(), i = a.findIndex(acc => acc.id === result.data.id), n = { ...result.data, token };
            if (i > -1) a[i] = n; else a.push(n);
            saveAccounts(a);
            switchAccount(result.data.id);
        } else {
            document.getElementById('login-error').innerText = `エラー: ${result.error?.message || '無効なトークンかAPIエラーです。'}`;
        }
    }

    function switchAccount(id) {
        cleanupState();
        setActiveAccountId(id);
        const a = getAccounts().find(a => a.id === id);
        if (!a) { showLoginScreen(); return }
        currentAccount = a;
        document.getElementById('token-input').value = '';
        updateView('app'); renderUserInfo(); renderAccountSwitcher(); loadGuilds(); connectWS();
    }

    function deleteAccount(id, e) {
        e.stopPropagation();
        if (!confirm("このアカウントを削除しますか？")) return;
        let a = getAccounts();
        a = a.filter(acc => acc.id !== id);
        saveAccounts(a);
        if (getActiveAccountId() === id) {
            if (a.length > 0) switchAccount(a[0].id);
            else { localStorage.removeItem('activeAccountId'); showLoginScreen(); }
        } else renderAccountSwitcher();
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

    async function loadGuilds() {
        if (!currentAccount) return;
        const { data: g } = await apiRequest(currentAccount.token, '/users/@me/guilds');
        if (!g) return;
        const l = document.getElementById('guild-list');
        l.innerHTML = '';
        g.forEach(s => {
            let el = document.createElement('div');
            el.id = `guild-${s.id}`;
            // w-12 h-12 (48px) を明示的に指定してサイズ崩れを防ぐ
            el.className = 'server-icon cursor-pointer w-12 h-12';
            el.title = s.name;
            el.onclick = () => loadChannels(s, el);
            if (s.icon) {
                el.innerHTML = `<img src="https://cdn.discordapp.com/icons/${s.id}/${s.icon}.png?size=128" class="object-cover w-full h-full rounded-full">`
            } else {
                el.innerHTML = `<div class="w-full h-full flex items-center justify-center bg-gray-700 text-white font-bold rounded-full text-sm">${s.name.replace(/[^\w\s]/gi, '').split(' ').map(w => w[0]).join('').substring(0, 2)}</div>`
            }
            l.appendChild(el);
        });
    }

    async function loadChannels(g, t) { if (!currentAccount) return; document.querySelectorAll('.server-icon.active').forEach(e => e.classList.remove('active')); if (t) t.classList.add('active'); document.getElementById('guild-name').innerText = g.name; const { data: c } = await apiRequest(currentAccount.token, `/guilds/${g.id}/channels`); if (!c) return; const l = document.getElementById('channel-list'); l.innerHTML = ''; const p = c.reduce((a, ch) => { (a[ch.parent_id || 'null'] = a[ch.parent_id || 'null'] || []).push(ch); return a; }, {}); Object.values(p).forEach(a => a.sort((x, y) => x.position - y.position)); const r = ch => { if (ch.type !== 0 && ch.type !== 5 && ch.type !== 2) return; const d = document.createElement('div'); d.id = `channel-${ch.id}`; d.className = 'channel-item p-2 rounded cursor-pointer mb-1 text-sm truncate'; d.innerHTML = `<span>${ch.type === 2 ? '🔊' : '#'} ${ch.name}</span>`; if (ch.type !== 2) d.onclick = () => selectChannel(ch); else d.classList.add('opacity-50', 'cursor-not-allowed'); l.appendChild(d); }; (p['null'] || []).forEach(r); c.filter(i => i.type === 4).sort((x, y) => x.position - y.position).forEach(cat => { const h = document.createElement('div'); h.className = 'px-1 pt-4 pb-1 text-xs font-bold uppercase text-[var(--text-secondary)]'; h.innerText = cat.name; l.appendChild(h); (p[cat.id] || []).forEach(r); }); updatePingDots(); }
    async function loadDms(t) { if (!currentAccount) return; document.querySelectorAll('.server-icon.active').forEach(e => e.classList.remove('active')); if (t) t.classList.add('active'); document.getElementById('guild-name').innerText = 'Direct Messages'; const { data: d } = await apiRequest(currentAccount.token, '/users/@me/channels'); if (!d) return; const l = document.getElementById('channel-list'); l.innerHTML = ''; d.sort((a, b) => (b.last_message_id || '0').localeCompare(a.last_message_id || '0')).forEach(dm => { const recipient = dm.recipients?.[0] || {}; const name = dm.name || recipient.global_name || recipient.username || 'DM'; const avatar = recipient.avatar ? `https://cdn.discordapp.com/avatars/${recipient.id}/${recipient.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${recipient.discriminator % 5}.png`; const el = document.createElement('div'); el.id = `channel-${dm.id}`; el.className = 'channel-item p-2 rounded cursor-pointer mb-1 text-sm truncate flex items-center gap-3'; el.innerHTML = `<img src="${avatar}" class="w-8 h-8 rounded-full"> <span class="flex-1">${name}</span>`; el.onclick = () => selectChannel(dm); l.appendChild(el); }); updatePingDots(); }

    async function loadSlashCommands(channel) {
        if (!currentAccount || !channel.id) return;
        const { data } = await apiRequest(currentAccount.token, `/channels/${channel.id}/application-commands/search?type=1&limit=25`);
        availableCommands = data?.application_commands || [];
    }

    function renderSlashCommands() {
        const picker = document.getElementById('slash-command-picker');
        picker.innerHTML = '<b>利用可能なコマンド:</b>';
        if (availableCommands.length === 0) {
            picker.innerHTML += '<div class="text-xs opacity-70">このチャンネルで利用できるコマンドはありません。</div>';
            return;
        }
        const list = document.createElement('div');
        list.className = 'mt-2 space-y-1 text-sm';
        availableCommands.forEach(cmd => {
            list.innerHTML += `<div class="p-1"><b>/${cmd.name}</b> <span class="text-xs opacity-60">${cmd.description}</span></div>`;
        });
        picker.appendChild(list);
    }

    async function selectChannel(ch) {
        currentChannel = ch; oldestMessageId = null; lastMessageInfo = { authorId: null, timestamp: null }; isLoadingMore = false; availableCommands = [];
        cancelReply(); cancelAttachment();
        
        delete pingCounts[ch.id];
        updatePingDots();

        document.querySelectorAll('.channel-item.active').forEach(e => e.classList.remove('active'));
        const cE = document.getElementById(`channel-${ch.id}`); if (cE) cE.classList.add('active');
        if (window.innerWidth < 768) showChatView();
        let name = ch.name || ch.recipients?.[0]?.global_name || ch.recipients?.[0]?.username || 'DM';
        document.getElementById('channel-name-text').innerHTML = `<span class="text-gray-500 mr-1">#</span><span>${name}</span>`;
        const con = document.getElementById('message-container'); con.innerHTML = '<div class="m-auto text-xs opacity-50">...</div>';
        
        loadSlashCommands(ch);

        const { data: ms } = await apiRequest(currentAccount.token, `/channels/${ch.id}/messages?limit=100`);
        con.innerHTML = '';
        if (Array.isArray(ms) && ms.length > 0) {
            oldestMessageId = ms[ms.length - 1].id;
            const lastReadId = ms[0].id;
            ms.reverse().forEach(m => renderMsg(m, { isNew: false, isPrepended: false }));
            if ((con.scrollHeight - con.scrollTop - con.clientHeight) < 1) { await apiRequest(currentAccount.token, `/channels/${ch.id}/messages/${lastReadId}/ack`, 'POST', {}); }
            setTimeout(() => con.scrollTop = con.scrollHeight, 0);
        }
        if (ch.guild_id) checkTimeoutStatus(ch.guild_id); else setInputState(true);
    }
    
    async function loadMoreMessages() { if (isLoadingMore || !oldestMessageId || !currentChannel) return; isLoadingMore = true; const con = document.getElementById('message-container'); const oldHeight = con.scrollHeight; const { data: messages } = await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages?limit=100&before=${oldestMessageId}`); if (Array.isArray(messages) && messages.length > 0) { oldestMessageId = messages[messages.length - 1].id; const fragment = document.createDocumentFragment(); messages.reverse(); let lastMessageInBatch = { authorId: null, timestamp: null }; messages.forEach(msg => { const isGrouped = msg.author.id === lastMessageInBatch.authorId && (new Date(msg.timestamp) - new Date(lastMessageInBatch.timestamp)) < 300 * 1000; const msgEl = createMessageElement(msg, isGrouped); fragment.appendChild(msgEl); lastMessageInBatch = { authorId: msg.author.id, timestamp: msg.timestamp }; }); con.prepend(fragment); con.scrollTop = con.scrollHeight - oldHeight; } else { oldestMessageId = null; } isLoadingMore = false; }
    function scrollToMessage(id) { const el = document.getElementById(`message-${id}`); if(el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('bg-yellow-500/10', 'transition-all', 'duration-1000'); setTimeout(()=>el.classList.remove('bg-yellow-500/10'), 2000); } }
    
    function renderSystemMessage(message) {
        const con = document.getElementById('message-container');
        const el = document.createElement('div');
        el.className = 'system-message flex gap-3 pt-4';
        const clydeAvatar = 'https://cdn.discordapp.com/embed/avatars/1.png';
        el.innerHTML = `<img src="${clydeAvatar}" class="w-10 h-10 rounded-full mt-0.5 flex-shrink-0"><div class="flex-1 min-w-0"><div><b class="text-sm">Clydeもどき</b><span class="text-xs opacity-40 ml-2">${new Date().toLocaleTimeString()}</span></div><div class="text-sm break-words">${message}</div></div>`;
        con.appendChild(el);
        con.scrollTop = con.scrollHeight;
    }

    function parseMarkdown(text) {
        if (!text) return '';
        let html = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const codeBlocks = [];
        html = html.replace(/```(?:[\w]*\n)?([\s\S]*?)```/g, (match, code) => { codeBlocks.push(`<span class="md-code-block">${code}</span>`); return `__CODE_BLOCK_${codeBlocks.length - 1}__`; });
        html = html.replace(/`([^`]+)`/g, (match, code) => { codeBlocks.push(`<span class="md-inline-code">${code}</span>`); return `__CODE_BLOCK_${codeBlocks.length - 1}__`; });
        html = html.replace(/\[([^\]]*)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2" target="_blank" class="text-[var(--text-link)] hover:underline">$1</a>');
        html = html.replace(/^### (.*$)/gm, '<div class="md-header-3">$1</div>').replace(/^## (.*$)/gm, '<div class="md-header-2">$1</div>').replace(/^# (.*$)/gm, '<div class="md-header-1">$1</div>');
        html = html.replace(/^> (.*$)/gm, '<div class="md-quote">$1</div>').replace(/^>>> ([\s\S]*)/gm, '<div class="md-quote">$1</div>');
        html = html.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\*(.*?)\*/g, '<i>$1</i>').replace(/__(.*?)__/g, '<u>$1</u>').replace(/~~(.*?)~~/g, '<s>$1</s>');
        html = html.replace(/(?<!href="|">)(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" class="text-[var(--text-link)] hover:underline">$1</a>');
        html = html.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => `<span class="mention">@${id}</span>`);
        html = html.replace(/&lt;a?:(\w+):(\d+)&gt;/g, (_, n, i) => `<img src="https://cdn.discordapp.com/emojis/${i}.webp?size=48&quality=lossless" alt=":${n}:" class="inline h-6 w-6">`);
        html = html.replace(/\n/g, '<br>');
        html = html.replace(/__CODE_BLOCK_(\d+)__/g, (match, index) => codeBlocks[index]);
        return html;
    }

    function createMessageElement(m, isGrouped) {
        let contentHtml = parseMarkdown(m.content);
        if (m.mentions) {
            m.mentions.forEach(u => {
                const regex = new RegExp(`@${u.id}`, 'g');
                contentHtml = contentHtml.replace(regex, `@${u.global_name || u.username}`);
            });
        }
        if (m.sticker_items) contentHtml += m.sticker_items.map(s=>`<img src="https://media.discordapp.net/stickers/${s.id}.webp?size=160" alt="${s.name}" class="w-32 h-32 mt-2"/>`).join('');
        if (m.attachments?.length > 0) contentHtml += m.attachments.map(a=>{ if (a.content_type?.startsWith('image')) return `<br><a href="${a.url}" target="_blank"><img src="${a.url}" class="max-w-xs cursor-pointer rounded-lg mt-2" style="display: block;"/></a>`; if (a.content_type?.startsWith('video')) return `<br><video src="${a.url}" controls playsinline muted class="max-w-xs rounded-lg mt-2"></video>`; return `<div class="mt-2 p-3 rounded-md text-[var(--text-primary)]" style="background-color:var(--bg-tertiary);"><a href="${a.url}" target="_blank" class="text-[var(--text-link)]">${a.filename}</a></div>` }).join(''); let replyPreviewHtml = ''; if (m.referenced_message) { const rm = m.referenced_message, rAuth = rm.author, rAuthName = rAuth.global_name || rAuth.username; const rCont = rm.content ? rm.content.substring(0, 100) : '添付ファイル'; const rAuthAvatar = rAuth.avatar ? `https://cdn.discordapp.com/avatars/${rAuth.id}/${rAuth.avatar}.png?size=32` : `https://cdn.discordapp.com/embed/avatars/${rAuth.discriminator % 5}.png`; replyPreviewHtml = `<div class="flex items-center ml-14 mb-1 cursor-pointer" onclick="scrollToMessage('${rm.id}')"><img src="${rAuthAvatar}" class="w-4 h-4 rounded-full mr-2"><b class="mr-2 text-sm text-[var(--text-link)]">${rAuthName}</b><span class="truncate text-xs opacity-70">${rCont}</span></div>`; } if (m.embeds?.length > 0) contentHtml += m.embeds.map(renderEmbed).join(''); const el = document.createElement('div'); el.id = `message-${m.id}`; el.className = "px-4 message-group relative"; const isAuthor = m.author.id === currentAccount.id; const isMentioned = m.mentions.some(user => user.id === currentAccount.id) || m.mention_everyone; const isReplyMention = m.type === 19 && m.referenced_message && m.referenced_message.author.id === currentAccount.id; if (!isAuthor && (isMentioned || isReplyMention)) el.classList.add('mention-highlight'); const toolbarHtml = `<div class="message-toolbar absolute -top-4 right-2 flex items-center gap-1 p-1 rounded-md shadow" style="background-color:var(--bg-secondary); color: var(--text-secondary);"> <button onclick='startReply(${JSON.stringify({id: m.id, author: m.author})})' title="Reply" class="p-1"><svg class="w-4 h-4" viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" fill="currentColor"/></svg></button> ${isAuthor ? `<button onclick='startEdit("${m.id}")' class="p-1" title="Edit"><svg class="w-4 h-4" viewBox="0 0 20 20"><path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828zM2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clip-rule="evenodd" fill="currentColor"></path></svg></button> <button onclick='deleteMessage("${m.id}")' class="p-1" title="Delete"><svg class="w-4 h-4" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clip-rule="evenodd" fill="currentColor"></path></svg></button>` : ''}</div>`; if (isGrouped) { el.innerHTML = `<div class="flex pl-14 pt-0.5"><div class="text-sm break-words message-content-text">${contentHtml}</div></div> ${toolbarHtml}`; } else { const displayName = m.author.global_name || m.author.username; const nm = `${displayName} <span class="text-xs opacity-60">(@${m.author.username})</span>`; const av = m.author.avatar ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${m.author.discriminator % 5}.png`; const replyLineHtml = m.referenced_message ? `<div class="absolute left-6 top-0 w-8 h-[24px] border-l-2 border-t-2 border-gray-400 dark:border-gray-600 rounded-tl-md"></div>` : ''; el.innerHTML = `${replyPreviewHtml}<div class="relative flex gap-3 pt-1">${replyLineHtml}<img src="${av}" class="w-10 h-10 rounded-full mt-0.5 flex-shrink-0"><div class="flex-1 min-w-0"><div><b class="text-sm">${nm}</b><span class="text-xs opacity-40 ml-2">${new Date(m.timestamp).toLocaleString()}</span></div><div class="text-sm break-words message-content-text">${contentHtml}</div></div></div> ${toolbarHtml}`; } el.querySelector('.message-content-text').dataset.originalContent = m.content; return el; }
    function renderMsg(m, options={}) { const { isNew = false, isPrepended = false } = options; if (!m.author || !currentAccount) return; const container = document.getElementById('message-container'); const isGrouped = !isPrepended && m.author.id === lastMessageInfo.authorId && (new Date(m.timestamp) - new Date(lastMessageInfo.timestamp)) < 300 * 1000; const el = createMessageElement(m, isGrouped); if (isPrepended) { container.prepend(el); } else { container.appendChild(el); lastMessageInfo = { authorId: m.author.id, timestamp: m.timestamp }; } }
    function renderEmbed(e) { const color = e.color ? `#${e.color.toString(16).padStart(6, '0')}` : 'var(--border-color)'; let fields = e.fields ? e.fields.map(f=>`<div class="${f.inline ? 'inline-block mr-4' : 'block'} min-w-[150px]"><b class="block">${f.name}</b><span>${f.value}</span></div>`).join('') : ''; return `<div class="mt-2 p-3 rounded-md flex gap-4" style="background-color: var(--bg-quaternary); border-left: 4px solid ${color};"> ${e.thumbnail ? `<a href="${e.thumbnail.url}" target="_blank"><img src="${e.thumbnail.proxy_url}" class="max-w-[80px] max-h-[80px] object-contain rounded-md"></a>` : ''} <div class="text-sm flex-1 min-w-0"> ${e.author ? `<div class="font-bold flex items-center gap-2 mb-1">${e.author.icon_url ? `<img src="${e.author.proxy_icon_url}" class="w-6 h-6 rounded-full">` : ''}<a href="${e.author.url || '#'}" target="_blank" class="hover:underline">${e.author.name}</a></div>` : ''} ${e.title ? `<a href="${e.url || '#'}" target="_blank" class="font-bold text-base block text-[var(--text-link)] hover:underline">${e.title}</a>` : ''} ${e.description ? `<div class="mt-1">${e.description}</div>` : ''} ${fields ? `<div class="mt-2 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">${fields}</div>` : ''} ${e.image ? `<a href="${e.image.url}" target="_blank"><img src="${e.image.proxy_url}" class="mt-2 rounded-lg max-w-xs"></a>` : ''} ${e.footer ? `<div class="mt-2 text-xs opacity-70 flex items-center gap-1.5">${e.footer.icon_url ? `<img src="${e.footer.proxy_icon_url}" class="w-4 h-4 rounded-full">` : ''}${e.footer.text}</div>` : ''} </div></div>`; }

    async function sendMessage() {
        const input = document.getElementById('message-input'); const content = input.value.trim();
        if (!currentChannel || (!content && !attachedFile)) return;
        if (content.length > 2000) { if (confirm("メッセージが2000文字を超えています。テキストファイルとして送信しますか？")) { attachedFile = new File([content],"message.txt"); return sendMessageWithFile({}) } return; }
        const nonce = Date.now().toString(); const payload = { content, nonce, tts: false };
        if (replyingTo) payload.message_reference = { message_id: replyingTo.messageId };
        if (attachedFile) return sendMessageWithFile(payload);
        input.value = ''; handleInput(); cancelReply();
        const res = await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages`, 'POST', payload);
        if (res.error) { input.value = content; handleInput(); renderSystemMessage(`エラー: ${res.error.message || '不明なエラーが発生しました。'}`); console.error("Send Error:", res.error); }
    }
    
    async function sendMessageWithFile(payload={}) { if (!attachedFile) return; const fd = new FormData(); fd.append('files[0]', attachedFile, attachedFile.name); fd.append('payload_json', JSON.stringify(payload)); const input = document.getElementById('message-input'); if (payload.content) input.value = ''; handleInput(); cancelReply(); cancelAttachment(); const res = await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages`, 'POST', fd, true); if (res.error) console.error("File Send Error", res.error); }
    function startReply(m) { replyingTo = { messageId: m.id }; document.getElementById('reply-bar').classList.remove('hidden'); document.getElementById('reply-username').innerText = `@${m.author.global_name || m.author.username}`; document.getElementById('message-input').focus(); }
    function cancelReply() { replyingTo = null; document.getElementById('reply-bar').classList.add('hidden'); }
    async function deleteMessage(id) { if (!currentChannel) return; if (confirm("本当にこのメッセージを削除しますか？")) { await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages/${id}`, 'DELETE'); } }
    function startEdit(id) { const msgEl = document.getElementById(`message-${id}`); if (!msgEl) return; const contentEl = msgEl.querySelector('.message-content-text'); if (!contentEl) return; const original = contentEl.dataset.originalContent; contentEl.innerHTML = `<textarea class="input-field w-full p-2 text-sm">${original}</textarea><div class="text-xs mt-1">escで<b class="text-[var(--text-link)] cursor-pointer">キャンセル</b> • enterで<b class="text-[var(--text-link)] cursor-pointer">保存</b></div>`; const textarea = contentEl.querySelector('textarea'); textarea.focus(); textarea.selectionStart = textarea.value.length; textarea.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); cancelEdit(id, original); } if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(id); } }; contentEl.querySelectorAll('b')[0].onclick = () => cancelEdit(id, original); contentEl.querySelectorAll('b')[1].onclick = () => saveEdit(id); }
    function cancelEdit(id, original) { const el = document.getElementById(`message-${id}`)?.querySelector('.message-content-text'); if (el) el.innerHTML = original.replace(/\n/g, '<br>'); }
    async function saveEdit(id) { const el = document.getElementById(`message-${id}`), textarea = el?.querySelector('textarea'); if (!textarea) return; const newContent = textarea.value.trim(); if (newContent) { await apiRequest(currentAccount.token, `/channels/${currentChannel.id}/messages/${id}`, 'PATCH', { content: newContent }); } else { deleteMessage(id); } }
    function setAttachment(file) { if (!file) return; attachedFile = file; document.getElementById('attachment-preview-name').textContent = file.name; document.getElementById('attachment-preview-bar').classList.remove('hidden'); handleInput(); }
    function cancelAttachment() { attachedFile = null; document.getElementById('file-input').value = ""; document.getElementById('attachment-preview-bar').classList.add('hidden'); handleInput(); }

    function connectWS() { if (!currentAccount || !currentAccount.token) return; if (ws) ws.close(); ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json'); ws.onmessage = e => { const d = JSON.parse(e.data); if (d.s) lastSequence = d.s; if (d.op === 10) { if (heartbeatInterval) clearInterval(heartbeatInterval); heartbeatInterval = setInterval(()=>ws.send(JSON.stringify({ op: 1, d: lastSequence })), d.d.heartbeat_interval); ws.send(JSON.stringify({ op: 2, d: { token: currentAccount.token, properties: { $os: "windows", $browser: "chrome", $device: "" } } })); } else if (d.t === 'MESSAGE_CREATE') { const con = document.getElementById('message-container'); const isScrolled = (con.scrollHeight - con.scrollTop - con.clientHeight) < 100; if (d.d.channel_id === currentChannel?.id) { renderMsg(d.d, { isNew: true, isPrepended: false }); if (isScrolled) { con.scrollTop = con.scrollHeight; apiRequest(currentAccount.token, `/channels/${d.d.channel_id}/messages/${d.d.id}/ack`, 'POST', {}); } } else if (d.d.guild_id && (d.d.mentions?.some(u=>u.id === currentAccount.id) || d.d.mention_everyone)) { updatePings(d.d.channel_id, 1, false, d.d.guild_id); } else if (!d.d.guild_id) { updatePings(d.d.channel_id, 1, true); } } else if (d.t === 'MESSAGE_DELETE' && d.d.channel_id === currentChannel?.id) document.getElementById(`message-${d.d.id}`)?.remove(); else if (d.t === 'MESSAGE_UPDATE' && d.d.channel_id === currentChannel?.id) { const el = document.getElementById(`message-${d.d.id}`); if (el && d.d.content !== undefined) { const contentEl = el.querySelector('.message-content-text'); if(contentEl) contentEl.innerHTML = parseMarkdown(d.d.content); } } }; ws.onclose = () => { if (heartbeatInterval) clearInterval(heartbeatInterval); if (currentAccount) setTimeout(connectWS, 5000); }; ws.onerror = e => { console.error('WS Error:', e); ws.close(); }; }
    function updatePings(id, count, isDm, guildId=null) { if (count > 0) { if (isDm) pingCounts[id] = { isDm: true }; else pingCounts[id] = { isDm: false, guildId: guildId }; } else { delete pingCounts[id]; } updatePingDots(); }
    function updatePingDots() { document.querySelectorAll('.ping-dot').forEach(d=>d.remove()); Object.keys(pingCounts).forEach(id=>{ const el = document.getElementById(`channel-${id}`); if (el && !el.querySelector('.ping-dot')) el.insertAdjacentHTML('beforeend', '<div class="ping-dot"></div>'); const {guildId} = pingCounts[id]; if (guildId) { const gEl = document.getElementById(`guild-${guildId}`); if (gEl && !gEl.querySelector('.ping-dot')) gEl.insertAdjacentHTML('beforeend', '<div class="ping-dot"></div>'); } }); }
    async function checkTimeoutStatus(guildId) { if (timeoutInterval) clearInterval(timeoutInterval); const { data: m } = await apiRequest(currentAccount.token, `/guilds/${guildId}/members/${currentAccount.id}`); const end = m && m.communication_disabled_until ? new Date(m.communication_disabled_until) : null; if (end && end > new Date()) { const update = () => { const now = new Date(), diff = (end - now) / 1000; if (diff <= 0) { setInputState(true); clearInterval(timeoutInterval); } else { const d = Math.floor(diff/86400), h = Math.floor(diff/3600)%24, m = Math.floor(diff/60)%60, s = Math.floor(diff%60); setInputState(false, `タイムアウト中: ${d>0?`${d}d `:''}${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`); } }; update(); timeoutInterval = setInterval(update, 1000); } else setInputState(true); }
    function setInputState(enabled, placeholder="メッセージを送信") { const i = document.getElementById('message-input'), s = document.getElementById('send-button'); i.disabled = !enabled; i.placeholder = placeholder; s.disabled = !enabled || (i.value.trim() === '' && !attachedFile); }
    function handleInput() { const i = document.getElementById('message-input'), c = document.getElementById('char-counter'), p = document.getElementById('slash-command-picker'); const l = i.value.length; i.style.height = 'auto'; i.style.height = (i.scrollHeight) + 'px'; setInputState(!i.disabled); c.textContent = l > 0 ? `${l}/2000` : ''; c.style.color = l > 2000 ? 'red' : ''; if (i.value.startsWith('/')) { p.classList.remove('hidden'); renderSlashCommands(); } else p.classList.add('hidden'); }
    function updateView(state) { const a = document.getElementById('auth-section'), m = document.getElementById('main-app'); if (state === 'auth') { a.classList.remove('hidden'); a.classList.add('flex'); m.classList.add('hidden'); document.getElementById('cancel-add-account-button').style.display = getAccounts().length > 0 ? 'block' : 'none'; } else { a.classList.add('hidden'); a.classList.remove('flex'); m.classList.remove('hidden'); m.classList.add('flex'); handleResize(); } }
    function applyTheme() { const b = document.getElementById('theme-toggle-btn'); if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme:dark)').matches)) { document.documentElement.classList.add('dark'); b.innerHTML = sunIcon; } else { document.documentElement.classList.remove('dark'); b.innerHTML = moonIcon; } }
    function handleResize() { if (window.innerWidth >= 768) { showChatView(); document.getElementById('sidebar-view').classList.remove('hidden'); } else { if (currentChannel) showChatView(); else showSidebarView(); } }
    function showSidebarView() { currentChannel = null; document.getElementById('sidebar-view').classList.remove('hidden'); document.getElementById('chat-section').classList.add('hidden'); }
    function showChatView() { document.getElementById('sidebar-view').classList.add('hidden'); document.getElementById('chat-section').classList.remove('hidden'); document.getElementById('chat-section').classList.add('flex'); }

    document.addEventListener('DOMContentLoaded', () => {
        applyTheme(); const a = getAccounts(); let i = getActiveAccountId();
        if (a.length > 0 && a.find(acc => acc.id === i)) switchAccount(i); else if (a.length > 0) switchAccount(a[0].id); else { showLoginScreen(); }
        function showLoginScreen() { updateView('auth') }
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
        document.getElementById('cancel-add-account-button').onclick = () => { const a = getAccounts(); if (a.length > 0) switchAccount(getActiveAccountId() || a[0].id); };
        window.addEventListener('resize', handleResize);
    });
