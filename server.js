// ==================== CONFIGURAÇÃO ====================
const API_BASE = '';
let currentUser = null;
let isOnline = navigator.onLine;
let syncQueue = [];

// Compatibilidade Safari
if (!window.fetch) {
    window.fetch = function() {
        throw new Error('Fetch not supported');
    };
}

// ==================== OFFLINE MODE ====================
window.addEventListener('online', () => {
    isOnline = true;
    document.getElementById('offline-indicator').classList.remove('show');
    processSyncQueue();
});

window.addEventListener('offline', () => {
    isOnline = false;
    document.getElementById('offline-indicator').classList.add('show');
});

function addToSyncQueue(request) {
    syncQueue.push(request);
    try {
        localStorage.setItem('v-sync-queue', JSON.stringify(syncQueue));
    } catch(e) {
        console.error('LocalStorage error:', e);
    }
}

async function processSyncQueue() {
    try {
        const queue = JSON.parse(localStorage.getItem('v-sync-queue') || '[]');
        for (const req of queue) {
            try {
                await fetch(req.url, {
                    method: req.method,
                    headers: req.headers,
                    body: req.body
                });
            } catch (e) {
                console.error('Sync failed:', e);
            }
        }
        localStorage.removeItem('v-sync-queue');
        syncQueue = [];
    } catch(e) {
        console.error('Process queue error:', e);
    }
}

// ==================== API WRAPPER ====================
const api = async (url, method, body) => {
    method = method || 'GET';
    const headers = { 
        'Content-Type': 'application/json'
    };
    
    const token = localStorage.getItem('v-token');
    if (token) {
        headers['Authorization'] = token;
    }
    
    if (!isOnline && method !== 'GET') {
        addToSyncQueue({ 
            url: API_BASE + url, 
            method, 
            headers, 
            body: body ? JSON.stringify(body) : null 
        });
        return { offline: true, success: true };
    }
    
    try {
        const response = await fetch(API_BASE + url, { 
            method, 
            headers, 
            body: body ? JSON.stringify(body) : null 
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('API Error:', response.status, errorText);
            return null;
        }
        
        return await response.json();
    } catch (error) {
        console.error('Fetch error:', error);
        if (method !== 'GET') {
            addToSyncQueue({ 
                url: API_BASE + url, 
                method, 
                headers, 
                body: body ? JSON.stringify(body) : null 
            });
        }
        return null;
    }
};

// ==================== SKELETON ====================
function showSkeleton(containerId, count) {
    count = count || 3;
    const container = document.getElementById(containerId);
    if (!container) return;
    
    container.innerHTML = Array(count).fill(0).map(() => 
        '<div class="card"><div class="skeleton" style="width:60%; height: 24px; margin-bottom: 12px;"></div>' +
        '<div class="skeleton" style="width:40%; height:16px; margin-bottom: 8px;"></div>' +
        '<div class="skeleton" style="width:80%; height:16px;"></div></div>'
    ).join('');
}

// ==================== COLLAPSIBLE ====================
function toggleCollapsible(id) {
    const content = document.getElementById(id);
    const button = content.previousElementSibling;
    const chevron = button.querySelector('.chevron');
    
    content.classList.toggle('active');
    button.classList.toggle('active');
    chevron.classList.toggle('rotate');
}

// ==================== AUTH ====================
let isLogin = true;

function toggleAuthMode() {
    isLogin = !isLogin;
    const regNome = document.getElementById('reg-nome');
    const btn = document.querySelector('#auth-page .btn');
    
    if (isLogin) {
        regNome.style.display = 'none';
        btn.textContent = 'ENTRAR';
    } else {
        regNome.style.display = 'block';
        btn.textContent = 'CRIAR CONTA';
    }
}

async function handleAuth() {
    const email = document.getElementById('email').value;
    const senha = document.getElementById('senha').value;
    const nome = document.getElementById('reg-nome').value;
    
    if (!email || !senha) {
        alert('Preencha todos os campos!');
        return;
    }
    
    if (!isLogin && !nome) {
        alert('Preencha seu nome!');
        return;
    }
    
    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
    const payload = { email: email, senha: senha };
    if (!isLogin) payload.nome = nome;
    
    const result = await api(endpoint, 'POST', payload);
    
    if (result && isLogin && result.token) {
        localStorage.setItem('v-token', result.token);
        localStorage.setItem('v-user', JSON.stringify(result));
        location.reload();
    } else if (!isLogin && result) {
        alert('Conta criada! Faça login.');
        toggleAuthMode();
    } else {
        alert('Erro. Verifique suas credenciais.');
    }
}

// ==================== INIT APP ====================
function initApp(user) {
    currentUser = user;
    
    document.getElementById('auth-page').style.display = 'none';
    document.getElementById('app-shell').style.display = 'block';
    document.getElementById('user-avatar').src = user.avatar;
    document.getElementById('user-name-label').textContent = user.nome;
    document.getElementById('user-role-label').textContent = user.role;
    
    // Criar navegação dinâmica
    const navItems = [
        { id: 'home', label: 'Início', roles: ['Aluno', 'Professor', 'Direcao', 'Admin'] },
        { id: 'biblioteca', label: 'Biblioteca', roles: ['Aluno', 'Professor', 'Direcao', 'Admin'] },
        { id: 'atividades', label: 'Tarefas', roles: ['Aluno', 'Professor', 'Direcao', 'Admin'] },
        { id: 'forum', label: 'Fórum', roles: ['Aluno', 'Professor', 'Direcao', 'Admin'] },
        { id: 'notas', label: 'Notas', roles: ['Aluno', 'Professor', 'Direcao', 'Admin'] },
        { id: 'presenca', label: 'Chamada', roles: ['Professor', 'Admin'] },
        { id: 'gestao', label: 'Gestão', roles: ['Professor', 'Direcao', 'Admin'] },
        { id: 'admin', label: 'Admin', roles: ['Admin'] }
    ];
    
    const nav = document.getElementById('main-nav');
    nav.innerHTML = navItems
        .filter(item => item.roles.includes(user.role))
        .map((item, idx) => 
            '<div class="nav-item' + (idx === 0 ? ' active' : '') + '" onclick="switchView(\'' + item.id + '\')">' + item.label + '</div>'
        ).join('') + '<div class="nav-item" onclick="logout()" style="color:var(--danger)">Sair</div>';
    
    // Mostrar campos de professor
    if (['Professor', 'Admin'].includes(user.role)) {
        const testesProf = document.getElementById('testes-prof');
        if (testesProf) testesProf.style.display = 'block';
    }
    
    loadMaterias();
    switchView('home');
}

// ==================== MATÉRIAS ====================
let materiasCache = [];

async function loadMaterias() {
    const materias = await api('/api/materias');
    if (materias) {
        materiasCache = materias;
        const options = materias.map(m => '<option value="' + m._id + '">' + m.nome + '</option>').join('');
        
        const selects = ['nota-materia', 'presenca-materia', 'teste-materia', 't-mat'];
        selects.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.innerHTML = '<option value="">Selecione a Matéria</option>' + options;
            }
        });
    }
}

// ==================== HOME (GRID/LIST) ====================
async function loadHome() {
    showSkeleton('home-grid', 4);
    const noticias = await api('/api/noticias');
    const atividades = await api('/api/atividades');
    
    const container = document.getElementById('home-grid');
    if (!container) return;
    
    let html = '';
    
    if (noticias && noticias.length > 0) {
        html += '<div class="card"><h4>📢 Últimas Notícias</h4>';
        noticias.slice(0, 3).forEach(n => {
            html += '<div style="padding: 8px 0; border-bottom: 1px solid var(--border);"><strong>' + n.titulo + '</strong><br>';
            html += '<small style="color: var(--text-dim);">' + n.autor + '</small></div>';
        });
        html += '</div>';
    }
    
    if (atividades && atividades.length > 0) {
        html += '<div class="card"><h4>📚 Próximas Tarefas</h4>';
        atividades.slice(0, 3).forEach(a => {
            html += '<div style="padding: 8px 0; border-bottom: 1px solid var(--border);"><strong>' + a.titulo + '</strong><br>';
            html += '<small style="color: var(--text-dim);">' + a.materia + ' - ' + new Date(a.dataEntrega).toLocaleDateString('pt-BR') + '</small></div>';
        });
        html += '</div>';
    }
    
    if (currentUser && currentUser.role === 'Aluno') {
        html += '<div class="card"><h4>📊 Minhas Estatísticas</h4><p>Em breve...</p></div>';
    }
    
    html += '<div class="card"><h4>💬 Atividade Recente</h4><p>Fórum ativo!</p></div>';
    
    container.innerHTML = html || '<div class="empty-state"><div class="empty-state-icon">🏠</div><p>Bem-vindo ao Vertex!</p></div>';
}

// ==================== BIBLIOTECA ====================
async function loadBiblioteca() {
    showSkeleton('artigos-list', 3);
    const artigos = await api('/api/artigos');
    
    const container = document.getElementById('artigos-list');
    if (!container) return;
    
    if (!artigos || artigos.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📚</div><p>Nenhum artigo publicado ainda.</p></div>';
        return;
    }
    
    container.innerHTML = artigos.map(a => {
        let html = '<div class="card"><h4>' + a.titulo + '</h4>';
        html += '<p style="white-space: pre-wrap; margin: 12px 0;">' + a.conteudo + '</p>';
        html += '<small style="color: var(--text-dim);">por <strong>' + a.autor + '</strong></small>';
        
        if (a.videoUrl) {
            const videoId = a.videoUrl.includes('youtube.com') ? a.videoUrl.split('v=')[1] : a.videoUrl.split('/').pop();
            html += '<iframe class="video-embed" src="https://www.youtube.com/embed/' + videoId + '" frameborder="0" allowfullscreen></iframe>';
        }
        
        if (a.exercicio) {
            html += '<div style="margin-top: 20px; padding: 16px; background: rgba(59, 130, 246, 0.05); border-radius: 12px;">';
            html += '<strong>❓ Exercício: ' + a.exercicio.pergunta + '</strong>';
            a.exercicio.opcoes.forEach((o, idx) => {
                html += '<div class="quiz-option" onclick="responderExercicio(\'' + a._id + '\', ' + idx + ')">' + o + '</div>';
            });
            html += '</div>';
        }
        
        html += '</div>';
        return html;
    }).join('');
}

async function publicarArtigo() {
    const titulo = document.getElementById('art-tit').value;
    const conteudo = document.getElementById('art-con').value;
    const videoUrl = document.getElementById('art-video').value;
    const exPergunta = document.getElementById('art-ex-p').value;
    const exOpcoes = document.getElementById('art-ex-o').value;
    const exCorreta = document.getElementById('art-ex-c').value;
    
    if (!titulo || !conteudo) {
        alert('Preencha título e conteúdo!');
        return;
    }
    
    const payload = { titulo: titulo, conteudo: conteudo };
    if (videoUrl) payload.videoUrl = videoUrl;
    
    if (exPergunta && exOpcoes && exCorreta) {
        payload.exercicio = {
            pergunta: exPergunta,
            opcoes: exOpcoes.split(',').map(s => s.trim()),
            respostaCorreta: parseInt(exCorreta)
        };
    }
    
    await api('/api/artigos', 'POST', payload);
    
    document.getElementById('art-tit').value = '';
    document.getElementById('art-con').value = '';
    document.getElementById('art-video').value = '';
    document.getElementById('art-ex-p').value = '';
    document.getElementById('art-ex-o').value = '';
    document.getElementById('art-ex-c').value = '';
    
    loadBiblioteca();
}

async function responderExercicio(artigoId, opcaoIdx) {
    const result = await api('/api/artigos/exercicio/' + artigoId, 'POST', { opcaoIndex: opcaoIdx });
    
    if (result) {
        const options = document.querySelectorAll('[onclick*="' + artigoId + '"]');
        options.forEach((opt, idx) => {
            opt.style.pointerEvents = 'none';
            if (idx === result.respostaCorreta) {
                opt.classList.add('correct');
            } else if (idx === opcaoIdx) {
                opt.classList.add('incorrect');
            }
        });
        
        alert(result.correto ? '✅ Correto!' : '❌ Incorreto!');
    }
}

// ==================== FORUM ====================
async function loadForum() {
    showSkeleton('forum-list', 3);
    const threads = await api('/api/forum');
    
    const container = document.getElementById('forum-list');
    if (!container) return;
    
    if (!threads || threads.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💬</div><p>Nenhum tópico ainda.</p></div>';
        return;
    }
    
    container.innerHTML = threads.map(t => {
        let html = '<div class="card"><h4>' + t.titulo + '</h4>';
        html += '<p style="margin: 12px 0;">' + t.conteudo + '</p>';
        html += '<small style="color: var(--text-dim);">por <strong>' + t.autor + '</strong></small>';
        
        if (t.temEnquete && t.enquete) {
            html += '<div style="margin-top: 20px; padding: 16px; background: rgba(59, 130, 246, 0.05); border-radius: 12px;">';
            html += '<strong>' + t.enquete.pergunta + '</strong>';
            const total = t.enquete.opcoes.reduce((sum, o) => sum + (o.votos || 0), 0);
            t.enquete.opcoes.forEach((o, idx) => {
                const pct = total > 0 ? Math.round((o.votos / total) * 100) : 0;
                html += '<div class="poll-option" onclick="votar(\'' + t._id + '\', ' + idx + ')" style="--percentage: ' + pct + '%">';
                html += '<div style="position: relative; z-index: 1; display: flex; justify-content: space-between;">';
                html += '<span>' + o.texto + '</span>';
                html += '<span style="color: var(--primary); font-weight: 700;">' + (o.votos || 0) + ' (' + pct + '%)</span>';
                html += '</div></div>';
            });
            html += '</div>';
        }
        
        html += '<div style="margin-top: 20px;">';
        if (t.comentarios) {
            t.comentarios.forEach(c => {
                html += '<div class="comment"><strong>' + c.autor + ':</strong> ' + c.texto + '</div>';
            });
        }
        html += '<input id="in-' + t._id + '" placeholder="Comentar..." style="margin-top: 12px;">';
        html += '<button class="btn" onclick="comentar(\'' + t._id + '\')" style="margin-top: 8px;">COMENTAR</button>';
        html += '</div></div>';
        
        return html;
    }).join('');
}

async function postarThread() {
    const titulo = document.getElementById('f-tit').value;
    const conteudo = document.getElementById('f-con').value;
    const enquetaPergunta = document.getElementById('f-enq-p').value;
    const enqueteOpcoes = document.getElementById('f-enq-o').value;
    
    if (!titulo || !conteudo) {
        alert('Preencha título e conteúdo!');
        return;
    }
    
    const payload = { titulo: titulo, conteudo: conteudo };
    
    if (enquetaPergunta && enqueteOpcoes) {
        payload.enquete = {
            pergunta: enquetaPergunta,
            opcoes: enqueteOpcoes.split(',').map(s => s.trim())
        };
    }
    
    await api('/api/forum', 'POST', payload);
    
    document.getElementById('f-tit').value = '';
    document.getElementById('f-con').value = '';
    document.getElementById('f-enq-p').value = '';
    document.getElementById('f-enq-o').value = '';
    
    loadForum();
}

async function comentar(threadId) {
    const input = document.getElementById('in-' + threadId);
    const texto = input.value;
    
    if (!texto) {
        alert('Digite um comentário!');
        return;
    }
    
    await api('/api/forum/comentar/' + threadId, 'POST', { texto: texto });
    input.value = '';
    loadForum();
}

async function votar(threadId, opcaoIndex) {
    await api('/api/forum/votar/' + threadId, 'POST', { opcaoIndex: opcaoIndex });
    loadForum();
}

// ==================== ATIVIDADES ====================
async function loadAtividades() {
    showSkeleton('atividades-list', 3);
    const atividades = await api('/api/atividades');
    
    const container = document.getElementById('atividades-list');
    if (!container) return;
    
    if (!atividades || atividades.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📚</div><p>Nenhuma tarefa cadastrada.</p></div>';
        return;
    }
    
    container.innerHTML = atividades.map(a => 
        '<div class="card"><div style="display: flex; justify-content: space-between; margin-bottom: 8px;">' +
        '<span class="badge primary">' + a.materia + '</span>' +
        '<small style="color: var(--text-dim);">📅 ' + new Date(a.dataEntrega).toLocaleDateString('pt-BR') + '</small></div>' +
        '<h4>' + a.titulo + '</h4>' +
        (a.descricao ? '<p style="font-size: 13px; color: var(--text-dim); margin-top: 8px;">' + a.descricao + '</p>' : '') +
        '</div>'
    ).join('');
}

async function criarTarefa() {
    const materia = document.getElementById('t-mat').value;
    const titulo = document.getElementById('t-tit').value;
    const descricao = document.getElementById('t-desc').value;
    const dataEntrega = document.getElementById('t-data').value;
    
    if (!materia || !titulo || !dataEntrega) {
        alert('Preencha os campos obrigatórios!');
        return;
    }
    
    await api('/api/atividades', 'POST', { materia: materia, titulo: titulo, descricao: descricao, dataEntrega: dataEntrega });
    
    document.getElementById('t-mat').value = '';
    document.getElementById('t-tit').value = '';
    document.getElementById('t-desc').value = '';
    document.getElementById('t-data').value = '';
    
    loadAtividades();
}

// ==================== NOTAS ====================
let gradeInputs = [];
let currentGradeIndex = 0;
let ctrlPressed = false;
let numberBuffer = '';

document.addEventListener('keydown', function(e) {
    if (e.key === 'Control' || e.key === 'Meta') {
        ctrlPressed = true;
    }
    
    if (ctrlPressed && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        numberBuffer += e.key;
    }
});

document.addEventListener('keyup', async function(e) {
    if ((e.key === 'Control' || e.key === 'Meta') && numberBuffer && gradeInputs.length > 0) {
        const value = parseFloat(numberBuffer) / 10;
        
        if (gradeInputs[currentGradeIndex] && value >= 0 && value <= 10) {
            const input = gradeInputs[currentGradeIndex];
            input.value = value.toFixed(1);
            input.classList.add('filled');
            
            await api('/api/notas', 'POST', {
                alunoId: input.dataset.aluno,
                materia: document.getElementById('nota-materia').value,
                bimestre: parseInt(document.getElementById('nota-bimestre').value),
                tipo: input.dataset.tipo,
                nota: value
            });
            
            currentGradeIndex++;
            if (gradeInputs[currentGradeIndex]) {
                gradeInputs[currentGradeIndex].focus();
            }
        }
        
        numberBuffer = '';
        ctrlPressed = false;
    }
});

async function loadNotas() {
    const materiaId = document.getElementById('nota-materia').value;
    const bimestre = document.getElementById('nota-bimestre').value;
    
    if (!materiaId) return;
    
    showSkeleton('notas-table', 1);
    
    const alunos = await api('/api/alunos');
    const notas = await api('/api/notas?materia=' + materiaId + '&bimestre=' + bimestre);
    
    if (!alunos) return;
    
    const notasMap = {};
    if (notas) {
        notas.forEach(function(n) {
            if (!notasMap[n.alunoId]) notasMap[n.alunoId] = {};
            notasMap[n.alunoId][n.tipo] = n.nota;
        });
    }
    
    const isTeacher = currentUser && ['Professor', 'Admin', 'Direcao'].includes(currentUser.role);
    
    gradeInputs = [];
    currentGradeIndex = 0;
    
    let html = '<div class="card" style="overflow-x: auto;"><table><thead><tr>';
    html += '<th>Aluno</th><th>AV1</th><th>AV2</th><th>P1</th><th>Média</th></tr></thead><tbody>';
    
    alunos.forEach(function(aluno) {
        const av1 = notasMap[aluno._id] ? notasMap[aluno._id].AV1 || '' : '';
        const av2 = notasMap[aluno._id] ? notasMap[aluno._id].AV2 || '' : '';
        const p1 = notasMap[aluno._id] ? notasMap[aluno._id].P1 || '' : '';
        
        let media = '-';
        let mediaColor = 'var(--text-dim)';
        
        if (av1 && av2 && p1) {
            const m = ((av1 + av2 + p1) / 3).toFixed(1);
            media = m;
            mediaColor = m >= 6 ? 'var(--success)' : 'var(--danger)';
        }
        
        html += '<tr><td><strong>' + aluno.nome + '</strong></td>';
        
        if (isTeacher) {
            html += '<td><input type="number" class="grade-input' + (av1 ? ' filled' : '') + '" value="' + av1 + '" data-aluno="' + aluno._id + '" data-tipo="AV1" step="0.1" min="0" max="10"></td>';
            html += '<td><input type="number" class="grade-input' + (av2 ? ' filled' : '') + '" value="' + av2 + '" data-aluno="' + aluno._id + '" data-tipo="AV2" step="0.1" min="0" max="10"></td>';
            html += '<td><input type="number" class="grade-input' + (p1 ? ' filled' : '') + '" value="' + p1 + '" data-aluno="' + aluno._id + '" data-tipo="P1" step="0.1" min="0" max="10"></td>';
        } else {
            html += '<td>' + (av1 || '-') + '</td>';
            html += '<td>' + (av2 || '-') + '</td>';
            html += '<td>' + (p1 || '-') + '</td>';
        }
        
        html += '<td style="color: ' + mediaColor + '; font-weight: 700; font-size: 16px;">' + media + '</td></tr>';
    });
    
    html += '</tbody></table></div>';
    
    document.getElementById('notas-table').innerHTML = html;
    
    if (isTeacher) {
        gradeInputs = Array.from(document.querySelectorAll('.grade-input'));
        gradeInputs.forEach(function(input, idx) {
            input.addEventListener('focus', function() {
                currentGradeIndex = idx;
            });
            
            input.addEventListener('blur', async function() {
                if (input.value && input.value >= 0 && input.value <= 10) {
                    input.classList.add('filled');
                    await api('/api/notas', 'POST', {
                        alunoId: input.dataset.aluno,
                        materia: document.getElementById('nota-materia').value,
                        bimestre: parseInt(document.getElementById('nota-bimestre').value),
                        tipo: input.dataset.tipo,
                        nota: parseFloat(input.value)
                    });
                }
            });
        });
        
        if (gradeInputs[0]) {
            gradeInputs[0].focus();
        }
    }
}

// ==================== TESTES ONLINE ====================
async function criarTeste() {
    const titulo = document.getElementById('teste-titulo').value;
    const materia = document.getElementById('teste-materia').value;
    const bimestre = document.getElementById('teste-bimestre').value;
    
    if (!titulo || !materia) {
        alert('Preencha todos os campos!');
        return;
    }
    
    await api('/api/testes', 'POST', { titulo: titulo, materia: materia, bimestre: parseInt(bimestre) });
    
    document.getElementById('teste-titulo').value = '';
    alert('Teste criado! Adicione questões.');
}

// ==================== PRESENÇA ====================
let presencaState = {};

async function loadPresenca() {
    const materiaId = document.getElementById('presenca-materia').value;
    const data = document.getElementById('presenca-data').value;
    
    if (!materiaId || !data) return;
    
    showSkeleton('presenca-list', 3);
    
    const alunos = await api('/api/alunos');
    const presencas = await api('/api/presencas?materia=' + materiaId + '&data=' + data);
    
    if (!alunos) return;
    
    presencaState = {};
    if (presencas) {
        presencas.forEach(function(p) {
            presencaState[p.alunoId] = p.status;
        });
    }
    
    document.getElementById('presenca-list').innerHTML = alunos.map(function(aluno) {
        return '<div class="card" style="display: flex; justify-content: space-between; align-items: center;">' +
            '<strong>' + aluno.nome + '</strong>' +
            '<div>' +
            '<button class="attendance-btn' + (presencaState[aluno._id] === 'P' ? ' present' : '') + '" onclick="togglePresenca(\'' + aluno._id + '\', \'P\')">✓ Presente</button>' +
            '<button class="attendance-btn' + (presencaState[aluno._id] === 'F' ? ' absent' : '') + '" onclick="togglePresenca(\'' + aluno._id + '\', \'F\')">✗ Falta</button>' +
            '</div></div>';
    }).join('');
    
    document.getElementById('salvar-presenca-btn').style.display = 'block';
}

function togglePresenca(alunoId, status) {
    presencaState[alunoId] = presencaState[alunoId] === status ? null : status;
    loadPresenca();
}

async function salvarPresenca() {
    const materiaId = document.getElementById('presenca-materia').value;
    const data = document.getElementById('presenca-data').value;
    
    const registros = Object.keys(presencaState)
        .filter(function(alunoId) { return presencaState[alunoId]; })
        .map(function(alunoId) {
            return {
                alunoId: alunoId,
                materia: materiaId,
                data: data,
                status: presencaState[alunoId]
            };
        });
    
    await api('/api/presencas/batch', 'POST', { registros: registros });
    alert('✅ Presença salva!');
}

// ==================== GESTÃO ====================
async function criarNoticia() {
    const titulo = document.getElementById('n-tit').value;
    const conteudo = document.getElementById('n-con').value;
    
    if (!titulo || !conteudo) {
        alert('Preencha os campos!');
        return;
    }
    
    await api('/api/noticias', 'POST', { titulo: titulo, conteudo: conteudo });
    
    document.getElementById('n-tit').value = '';
    document.getElementById('n-con').value = '';
    
    alert('Notícia publicada!');
}

async function criarOcorrencia() {
    const alunoNome = document.getElementById('o-aluno').value;
    const tipo = document.getElementById('o-tipo').value;
    const descricao = document.getElementById('o-desc').value;
    
    if (!alunoNome || !descricao) {
        alert('Preencha os campos!');
        return;
    }
    
    await api('/api/ocorrencias', 'POST', { alunoNome: alunoNome, tipo: tipo, descricao: descricao });
    
    document.getElementById('o-aluno').value = '';
    document.getElementById('o-desc').value = '';
    
    alert('Ocorrência registrada!');
}

// ==================== ADMIN ====================
async function loadAdminUsers() {
    showSkeleton('admin-users-list', 3);
    const users = await api('/api/admin/users');
    
    if (!users) return;
    
    document.getElementById('admin-users-list').innerHTML = users.map(function(user) {
        return '<div class="card" style="display: flex; justify-content: space-between; align-items: center; gap: 16px;">' +
            '<div style="flex: 1;"><strong>' + user.nome + '</strong><br>' +
            '<small style="color: var(--text-dim);">' + user.email + '</small><br>' +
            '<span class="badge primary">' + user.role + '</span></div>' +
            '<div style="display: flex; gap: 8px;">' +
            '<select id="role-' + user._id + '" style="padding: 10px; border-radius: 8px;">' +
            '<option' + (user.role === 'Aluno' ? ' selected' : '') + '>Aluno</option>' +
            '<option' + (user.role === 'Professor' ? ' selected' : '') + '>Professor</option>' +
            '<option' + (user.role === 'Direcao' ? ' selected' : '') + '>Direcao</option>' +
            '<option' + (user.role === 'Admin' ? ' selected' : '') + '>Admin</option>' +
            '</select>' +
            '<button class="btn" style="padding: 10px 16px;" onclick="updateRole(\'' + user._id + '\')">SALVAR</button>' +
            '</div></div>';
    }).join('');
}

async function updateRole(userId) {
    const newRole = document.getElementById('role-' + userId).value;
    await api('/api/admin/update-role', 'POST', { userId: userId, role: newRole });
    loadAdminUsers();
}

// ==================== PERFIL ====================
function loadProfile() {
    if (!currentUser) return;
    
    document.getElementById('profile-name').textContent = currentUser.nome;
    document.getElementById('profile-role').textContent = currentUser.role;
    document.getElementById('profile-avatar').src = currentUser.avatar;
    
    const savedBanner = localStorage.getItem('v-banner-color');
    if (savedBanner) {
        document.getElementById('profile-banner').style.background = savedBanner;
        document.getElementById('profile-banner-color').value = savedBanner;
    }
    
    const savedBio = localStorage.getItem('v-bio');
    if (savedBio) {
        document.getElementById('profile-bio').value = savedBio;
    }
}

function salvarPerfil() {
    const bio = document.getElementById('profile-bio').value;
    const bannerColor = document.getElementById('profile-banner-color').value;
    
    localStorage.setItem('v-bio', bio);
    localStorage.setItem('v-banner-color', bannerColor);
    
    document.getElementById('profile-banner').style.background = bannerColor;
    
    alert('✅ Perfil atualizado!');
}

// ==================== NAVIGATION ====================
function switchView(viewName) {
    document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
    document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
    
    const view = document.getElementById('view-' + viewName);
    if (view) view.classList.add('active');
    
    document.querySelectorAll('.nav-item').forEach(function(item) {
        if (item.onclick && item.onclick.toString().indexOf(viewName) > -1) {
            item.classList.add('active');
        }
    });
    
    if (viewName === 'home') loadHome();
    if (viewName === 'biblioteca') loadBiblioteca();
    if (viewName === 'atividades') loadAtividades();
    if (viewName === 'forum') loadForum();
    if (viewName === 'admin') loadAdminUsers();
    if (viewName === 'profile') loadProfile();
}

function logout() {
    if (confirm('Deseja sair?')) {
        localStorage.clear();
        location.reload();
    }
}

// ==================== INIT ====================
window.addEventListener('DOMContentLoaded', function() {
    const userJson = localStorage.getItem('v-user');
    
    if (userJson) {
        try {
            const user = JSON.parse(userJson);
            initApp(user);
        } catch (e) {
            console.error('User data error:', e);
            localStorage.clear();
        }
    }
    
    const presencaDataInput = document.getElementById('presenca-data');
    if (presencaDataInput) {
        const today = new Date();
        presencaDataInput.value = today.toISOString().split('T')[0];
    }
});
