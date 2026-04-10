const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());
app.use(express.static(__dirname));

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://beilianalvarenga_db_user:Beilian1010@cluster0.hhyotua.mongodb.net/Vertex?retryWrites=true&w=majority";
const JWT_SECRET = process.env.JWT_SECRET || "beilian_secret_key_123";
const PORT = process.env.PORT || 10000;

mongoose.connect(MONGO_URI, { dbName: 'Vertex' })
    .then(() => {
        console.log("✅ [DATABASE] Conectado");
        initializeDefaultData();
    })
    .catch(err => console.error("❌ [DATABASE] Erro:", err.message));

// ==================== SCHEMAS ====================
const UserSchema = new mongoose.Schema({
    nome: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    senha: { type: String, required: true },
    role: { type: String, enum: ['Aluno', 'Professor', 'Direcao', 'Admin'], default: 'Aluno' },
    avatar: String,
    bio: String,
    bannerColor: { type: String, default: '#3b82f6' },
    serie: String, // "1", "2", ..., "9", "1EM", "2EM", "3EM"
    createdAt: { type: Date, default: Date.now }
});

const MateriaSchema = new mongoose.Schema({
    nome: { type: String, required: true },
    series: [String], // Séries que têm essa matéria
    professor: String,
    createdAt: { type: Date, default: Date.now }
});

const ThreadSchema = new mongoose.Schema({
    titulo: { type: String, required: true },
    conteudo: { type: String, required: true },
    autor: { type: String, required: true },
    temEnquete: { type: Boolean, default: false },
    enquete: {
        pergunta: String,
        opcoes: [{ texto: String, votos: { type: Number, default: 0 } }],
        votosUsuarios: [String]
    },
    comentarios: [{ autor: String, texto: String, createdAt: { type: Date, default: Date.now } }],
    createdAt: { type: Date, default: Date.now }
});

const NoticiaSchema = new mongoose.Schema({
    titulo: { type: String, required: true },
    conteudo: String,
    autor: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

const AtividadeSchema = new mongoose.Schema({
    titulo: { type: String, required: true },
    descricao: String,
    materia: { type: String, required: true },
    dataEntrega: { type: Date, required: true },
    autor: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

const OcorrenciaSchema = new mongoose.Schema({
    alunoNome: { type: String, required: true },
    descricao: { type: String, required: true },
    tipo: { type: String, enum: ['Advertência', 'Suspensão', 'Elogio', 'Observação'], required: true },
    autor: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

const NotaSchema = new mongoose.Schema({
    alunoId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    materia: { type: mongoose.Schema.Types.ObjectId, ref: 'Materia', required: true },
    bimestre: { type: Number, min: 1, max: 4, required: true },
    tipo: { type: String, enum: ['AV1', 'AV2', 'P1'], required: true },
    nota: { type: Number, min: 0, max: 10, required: true },
    createdAt: { type: Date, default: Date.now }
});

const PresencaSchema = new mongoose.Schema({
    alunoId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    materia: { type: mongoose.Schema.Types.ObjectId, ref: 'Materia', required: true },
    data: { type: Date, required: true },
    status: { type: String, enum: ['P', 'F'], required: true },
    createdAt: { type: Date, default: Date.now }
});

const ArtigoSchema = new mongoose.Schema({
    titulo: { type: String, required: true },
    conteudo: { type: String, required: true },
    autor: { type: String, required: true },
    videoUrl: String,
    exercicio: {
        pergunta: String,
        opcoes: [String],
        respostaCorreta: Number
    },
    visualizacoes: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});

const TesteSchema = new mongoose.Schema({
    titulo: { type: String, required: true },
    materia: { type: mongoose.Schema.Types.ObjectId, ref: 'Materia', required: true },
    bimestre: { type: Number, min: 1, max: 4, required: true },
    professor: { type: String, required: true },
    questoes: [{
        pergunta: String,
        opcoes: [String],
        respostaCorreta: Number
    }],
    ativo: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

const RespostaTesteSchema = new mongoose.Schema({
    testeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Teste', required: true },
    alunoId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    respostas: [Number],
    nota: Number,
    createdAt: { type: Date, default: Date.now }
});

// ==================== MODELS ====================
const User = mongoose.model('User', UserSchema);
const Materia = mongoose.model('Materia', MateriaSchema);
const Thread = mongoose.model('Thread', ThreadSchema);
const Noticia = mongoose.model('Noticia', NoticiaSchema);
const Atividade = mongoose.model('Atividade', AtividadeSchema);
const Ocorrencia = mongoose.model('Ocorrencia', OcorrenciaSchema);
const Nota = mongoose.model('Nota', NotaSchema);
const Presenca = mongoose.model('Presenca', PresencaSchema);
const Artigo = mongoose.model('Artigo', ArtigoSchema);
const Teste = mongoose.model('Teste', TesteSchema);
const RespostaTeste = mongoose.model('RespostaTeste', RespostaTesteSchema);

// ==================== INIT DEFAULT DATA ====================
async function initializeDefaultData() {
    try {
        const count = await Materia.countDocuments();
        if (count === 0) {
            const materias = [
                // Fundamental 1-5 (Professor polivalente)
                { nome: 'Polivalente', series: ['1', '2', '3', '4', '5'] },
                
                // Fundamental 6-9
                { nome: 'Matemática', series: ['6', '7', '8', '9', '1EM', '2EM', '3EM'] },
                { nome: 'Português', series: ['6', '7', '8', '9', '1EM', '2EM', '3EM'] },
                { nome: 'Inglês', series: ['6', '7', '8', '9', '1EM', '2EM', '3EM'] },
                { nome: 'Ciências', series: ['6', '7', '8', '9'] },
                { nome: 'História', series: ['6', '7', '8', '9', '1EM', '2EM', '3EM'] },
                { nome: 'Geografia', series: ['6', '7', '8', '9', '1EM', '2EM', '3EM'] },
                { nome: 'Arte', series: ['6', '7', '8', '9', '1EM', '2EM', '3EM'] },
                { nome: 'Educação Física', series: ['6', '7', '8', '9', '1EM', '2EM', '3EM'] },
                
                // Ensino Médio específicas
                { nome: 'Física', series: ['1EM', '2EM', '3EM'] },
                { nome: 'Química', series: ['1EM', '2EM', '3EM'] },
                { nome: 'Biologia', series: ['1EM', '2EM', '3EM'] },
                { nome: 'Filosofia', series: ['1EM', '2EM', '3EM'] },
                { nome: 'Sociologia', series: ['1EM', '2EM', '3EM'] },
                { nome: 'Redação', series: ['1EM', '2EM', '3EM'] }
            ];
            
            await Materia.insertMany(materias);
            console.log("✅ Matérias padrão criadas");
        }
    } catch (error) {
        console.error("Erro ao criar matérias padrão:", error);
    }
}

// ==================== MIDDLEWARE ====================
const authenticate = (req, res, next) => {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ msg: "Token não fornecido" });
    
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (error) {
        return res.status(401).json({ msg: "Token inválido" });
    }
};

const authorize = (minRole) => (req, res, next) => {
    const roles = ['Aluno', 'Professor', 'Direcao', 'Admin'];
    if (roles.indexOf(req.user.role) >= roles.indexOf(minRole)) return next();
    return res.status(403).json({ msg: "Permissão insuficiente" });
};

// ==================== AUTH ====================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        if (!nome || !email || !senha) return res.status(400).json({ msg: "Campos obrigatórios" });
        
        const existing = await User.findOne({ email });
        if (existing) return res.status(400).json({ msg: "Email já cadastrado" });
        
        const hashedPassword = await bcrypt.hash(senha, 10);
        await User.create({
            nome,
            email,
            senha: hashedPassword,
            avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + nome
        });
        
        res.status(201).json({ msg: "Usuário criado" });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ msg: "Erro ao registrar" });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, senha } = req.body;
        if (!email || !senha) return res.status(400).json({ msg: "Campos obrigatórios" });
        
        const user = await User.findOne({ email });
        if (!user || !(await bcrypt.compare(senha, user.senha))) {
            return res.status(401).json({ msg: "Credenciais inválidas" });
        }
        
        const token = jwt.sign(
            { id: user._id, role: user.role, nome: user.nome },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        res.json({ token, nome: user.nome, role: user.role, avatar: user.avatar });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ msg: "Erro ao fazer login" });
    }
});

// ==================== MATERIAS ====================
app.get('/api/materias', authenticate, async (req, res) => {
    try {
        const materias = await Materia.find();
        res.json(materias);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao buscar matérias" });
    }
});

// ==================== FORUM ====================
app.get('/api/forum', authenticate, async (req, res) => {
    try {
        const threads = await Thread.find().sort({ createdAt: -1 });
        res.json(threads);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao buscar fórum" });
    }
});

app.post('/api/forum', authenticate, async (req, res) => {
    try {
        const { titulo, conteudo, enquete } = req.body;
        const threadData = { titulo, conteudo, autor: req.user.nome };
        
        if (enquete && enquete.pergunta && enquete.opcoes) {
            threadData.temEnquete = true;
            threadData.enquete = {
                pergunta: enquete.pergunta,
                opcoes: enquete.opcoes.map(texto => ({ texto, votos: 0 })),
                votosUsuarios: []
            };
        }
        
        const thread = await Thread.create(threadData);
        res.status(201).json(thread);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao criar thread" });
    }
});

app.post('/api/forum/comentar/:id', authenticate, async (req, res) => {
    try {
        const thread = await Thread.findById(req.params.id);
        if (!thread) return res.status(404).json({ msg: "Thread não encontrada" });
        
        thread.comentarios.push({ autor: req.user.nome, texto: req.body.texto });
        await thread.save();
        res.json(thread);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao comentar" });
    }
});

app.post('/api/forum/votar/:id', authenticate, async (req, res) => {
    try {
        const thread = await Thread.findById(req.params.id);
        if (!thread || !thread.temEnquete) return res.status(404).json({ msg: "Enquete não encontrada" });
        
        if (!thread.enquete.votosUsuarios) thread.enquete.votosUsuarios = [];
        if (thread.enquete.votosUsuarios.includes(req.user.id)) {
            return res.status(400).json({ msg: "Já votou" });
        }
        
        thread.enquete.opcoes[req.body.opcaoIndex].votos += 1;
        thread.enquete.votosUsuarios.push(req.user.id);
        await thread.save();
        res.json(thread);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao votar" });
    }
});

// ==================== NOTICIAS ====================
app.get('/api/noticias', authenticate, async (req, res) => {
    try {
        const noticias = await Noticia.find().sort({ createdAt: -1 });
        res.json(noticias);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao buscar notícias" });
    }
});

app.post('/api/noticias', authenticate, authorize('Direcao'), async (req, res) => {
    try {
        const noticia = await Noticia.create({ ...req.body, autor: req.user.nome });
        res.status(201).json(noticia);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao criar notícia" });
    }
});

// ==================== ATIVIDADES ====================
app.get('/api/atividades', authenticate, async (req, res) => {
    try {
        const atividades = await Atividade.find().sort({ dataEntrega: 1 });
        res.json(atividades);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao buscar atividades" });
    }
});

app.post('/api/atividades', authenticate, authorize('Professor'), async (req, res) => {
    try {
        const atividade = await Atividade.create({ ...req.body, autor: req.user.nome });
        res.status(201).json(atividade);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao criar atividade" });
    }
});

// ==================== OCORRENCIAS ====================
app.get('/api/ocorrencias', authenticate, async (req, res) => {
    try {
        const query = req.user.role === 'Aluno' ? { alunoNome: req.user.nome } : {};
        const ocorrencias = await Ocorrencia.find(query).sort({ createdAt: -1 });
        res.json(ocorrencias);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao buscar ocorrências" });
    }
});

app.post('/api/ocorrencias', authenticate, authorize('Professor'), async (req, res) => {
    try {
        const ocorrencia = await Ocorrencia.create({ ...req.body, autor: req.user.nome });
        res.status(201).json(ocorrencia);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao criar ocorrência" });
    }
});

// ==================== NOTAS ====================
app.get('/api/notas', authenticate, async (req, res) => {
    try {
        const { materia, bimestre } = req.query;
        let query = {};
        if (materia) query.materia = materia;
        if (bimestre) query.bimestre = parseInt(bimestre);
        if (req.user.role === 'Aluno') query.alunoId = req.user.id;
        
        const notas = await Nota.find(query);
        res.json(notas);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao buscar notas" });
    }
});

app.post('/api/notas', authenticate, authorize('Professor'), async (req, res) => {
    try {
        const { alunoId, materia, bimestre, tipo, nota } = req.body;
        const existing = await Nota.findOne({ alunoId, materia, bimestre, tipo });
        
        if (existing) {
            existing.nota = nota;
            await existing.save();
            res.json(existing);
        } else {
            const newNota = await Nota.create({ alunoId, materia, bimestre, tipo, nota });
            res.status(201).json(newNota);
        }
    } catch (error) {
        res.status(500).json({ msg: "Erro ao salvar nota" });
    }
});

// ==================== PRESENCAS ====================
app.get('/api/presencas', authenticate, async (req, res) => {
    try {
        const { materia, data } = req.query;
        let query = {};
        if (materia) query.materia = materia;
        if (data) query.data = new Date(data);
        
        const presencas = await Presenca.find(query);
        res.json(presencas);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao buscar presenças" });
    }
});

app.post('/api/presencas/batch', authenticate, authorize('Professor'), async (req, res) => {
    try {
        const { registros } = req.body;
        for (const reg of registros) {
            const existing = await Presenca.findOne({
                alunoId: reg.alunoId,
                materia: reg.materia,
                data: new Date(reg.data)
            });
            
            if (existing) {
                existing.status = reg.status;
                await existing.save();
            } else {
                await Presenca.create(reg);
            }
        }
        res.json({ msg: "Presenças salvas" });
    } catch (error) {
        res.status(500).json({ msg: "Erro ao salvar presenças" });
    }
});

// ==================== BIBLIOTECA ====================
app.get('/api/artigos', authenticate, async (req, res) => {
    try {
        const artigos = await Artigo.find().sort({ createdAt: -1 });
        res.json(artigos);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao buscar artigos" });
    }
});

app.post('/api/artigos', authenticate, async (req, res) => {
    try {
        const artigo = await Artigo.create({ ...req.body, autor: req.user.nome });
        res.status(201).json(artigo);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao criar artigo" });
    }
});

app.post('/api/artigos/exercicio/:id', authenticate, async (req, res) => {
    try {
        const artigo = await Artigo.findById(req.params.id);
        if (!artigo || !artigo.exercicio) return res.status(404).json({ msg: "Exercício não encontrado" });
        
        const correto = artigo.exercicio.respostaCorreta === req.body.opcaoIndex;
        res.json({ correto, respostaCorreta: artigo.exercicio.respostaCorreta });
    } catch (error) {
        res.status(500).json({ msg: "Erro ao responder exercício" });
    }
});

// ==================== TESTES ====================
app.get('/api/testes', authenticate, async (req, res) => {
    try {
        const testes = await Teste.find({ ativo: true }).sort({ createdAt: -1 });
        res.json(testes);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao buscar testes" });
    }
});

app.post('/api/testes', authenticate, authorize('Professor'), async (req, res) => {
    try {
        const teste = await Teste.create({ ...req.body, professor: req.user.nome });
        res.status(201).json(teste);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao criar teste" });
    }
});

// ==================== ALUNOS ====================
app.get('/api/alunos', authenticate, async (req, res) => {
    try {
        const alunos = await User.find({ role: 'Aluno' }, 'nome email');
        res.json(alunos);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao buscar alunos" });
    }
});

// ==================== ADMIN ====================
app.get('/api/admin/users', authenticate, authorize('Admin'), async (req, res) => {
    try {
        const users = await User.find({}, 'nome email role');
        res.json(users);
    } catch (error) {
        res.status(500).json({ msg: "Erro ao buscar usuários" });
    }
});

app.post('/api/admin/update-role', authenticate, authorize('Admin'), async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.body.userId, { role: req.body.role });
        res.json({ msg: "Role atualizada" });
    } catch (error) {
        res.status(500).json({ msg: "Erro ao atualizar role" });
    }
});

// ==================== CATCH ALL ====================
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('✅ VERTEX ONLINE NA PORTA ' + PORT);
});
